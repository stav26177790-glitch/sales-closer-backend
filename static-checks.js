#!/usr/bin/env node
/**
 * static-checks.js
 *
 * Проверки, которые НЕ требуют вызова LLM (agentRunner.callAgent) —
 * работают чистым парсингом текста stateMachine.js и agents/*.md.
 * Быстрые (доли секунды), можно гонять на каждый коммит/PR.
 *
 * Запуск:
 *   node static-checks.js [--root <путь к корню backend-репо>]
 *
 * По умолчанию --root = текущая директория, ожидается layout:
 *   <root>/stateMachine.js
 *   <root>/agents/diagnostic_agent.md
 *   <root>/agents/reviewer_agent.md
 *   <root>/agents/memory_agent.md
 *   <root>/agents/composer_agent.md
 */
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
const ROOT = arg('--root', process.cwd());

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

const paths = {
  stateMachine: path.join(ROOT, 'stateMachine.js'),
  agentRunner: path.join(ROOT, 'agentRunner.js'),
  diagnostic: path.join(ROOT, 'agents', 'diagnostic_agent.md'),
  reviewer: path.join(ROOT, 'agents', 'reviewer_agent.md'),
  memory: path.join(ROOT, 'agents', 'memory_agent.md'),
  composer: path.join(ROOT, 'agents', 'composer_agent.md'),
  strategy: path.join(ROOT, 'agents', 'strategy_agent.md')
};

const results = [];
function check(id, title, fn) {
  let status, detail;
  try {
    const r = fn();
    status = r.pass ? 'PASS' : 'FAIL';
    detail = r.detail || '';
  } catch (e) {
    status = 'ERROR';
    detail = e.message;
  }
  results.push({ id, title, status, detail });
}

// --- Загрузка файлов ---
const src = {};
for (const [k, p] of Object.entries(paths)) {
  src[k] = readFileSafe(p);
}

// ---------------------------------------------------------------------
// Баг №17/№10 — коды критериев reviewer'а не должны утекать к менеджеру
// нерегистрированными. Каждый ключ из checklist в reviewer_agent.md
// должен присутствовать в CRITERIA_LABELS в stateMachine.js.
// ---------------------------------------------------------------------
check('bug17', 'Все ключи checklist reviewer\'а зарегистрированы в CRITERIA_LABELS', () => {
  if (!src.reviewer) return { pass: false, detail: `не найден файл ${paths.reviewer}` };
  if (!src.stateMachine) return { pass: false, detail: `не найден файл ${paths.stateMachine}` };

  const checklistBlockMatch = src.reviewer.match(/"checklist":\s*{([^}]*)}/);
  if (!checklistBlockMatch) return { pass: false, detail: 'блок "checklist" не найден в reviewer_agent.md' };
  const checklistKeys = [...checklistBlockMatch[1].matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
  if (!checklistKeys.length) return { pass: false, detail: 'не удалось распарсить ключи checklist' };

  const labelsBlockMatch = src.stateMachine.match(/CRITERIA_LABELS\s*=\s*{([^}]*)}/s);
  if (!labelsBlockMatch) return { pass: false, detail: 'CRITERIA_LABELS не найден в stateMachine.js' };
  const labelKeys = [...labelsBlockMatch[1].matchAll(/([a-z_]+):\s*'/g)].map((m) => m[1]);

  const missing = checklistKeys.filter((k) => !labelKeys.includes(k));
  return {
    pass: missing.length === 0,
    detail: missing.length
      ? `не зарегистрированы в CRITERIA_LABELS: ${missing.join(', ')}`
      : `все ${checklistKeys.length} ключей checklist зарегистрированы`
  };
});

// ---------------------------------------------------------------------
// Баг №21 — реальная дата должна доходить до всех агентов через baseInput.today
// ---------------------------------------------------------------------
check('bug21', 'baseInput.today выставляется реальной датой', () => {
  if (!src.stateMachine) return { pass: false, detail: `не найден файл ${paths.stateMachine}` };
  // Допускаем оба варианта: отдельное присваивание "baseInput.today = ..."
  // ИЛИ поле "today:" внутри литерала объекта baseInput = { ... }.
  const asAssignment = /baseInput\.today\s*=\s*new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/.test(src.stateMachine);
  const baseInputBlock = src.stateMachine.match(/const baseInput = {([\s\S]*?)\n {2}};?/);
  const asLiteralField = baseInputBlock
    ? /today\s*:\s*new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/.test(baseInputBlock[1])
    : false;
  const hasToday = asAssignment || asLiteralField;
  return {
    pass: hasToday,
    detail: hasToday
      ? `найдено (${asAssignment ? 'отдельное присваивание' : 'поле литерала объекта baseInput'})`
      : 'ни baseInput.today = ..., ни поле today: внутри baseInput не найдены'
  };
});

// ---------------------------------------------------------------------
// Баг №22 — diagnostic_output обязан передаваться в memoryInput внутри runMemoryUpdate()
// ---------------------------------------------------------------------
check('bug22', 'diagnostic_output передаётся в memoryInput в runMemoryUpdate()', () => {
  if (!src.stateMachine) return { pass: false, detail: `не найден файл ${paths.stateMachine}` };
  const fnMatch = src.stateMachine.match(/function runMemoryUpdate\([\s\S]*?\n}\n/);
  if (!fnMatch) return { pass: false, detail: 'функция runMemoryUpdate не найдена (возможно, изменено имя/сигнатура — проверить вручную)' };
  const has = /diagnostic_output\s*:/.test(fnMatch[0]);
  return { pass: has, detail: has ? 'найдено' : 'diagnostic_output не передаётся внутри runMemoryUpdate()' };
});

// ---------------------------------------------------------------------
// Баг №24 (НОВЫЙ, найден при подготовке этого набора) — критерии СОПРАНО
// (scores/criteria_assessment) сохраняются в statePatch.criteria с тем же
// фоллбэком, что используется для показа в чате (formatAgentReplyForChat
// читает diag?.criteria_assessment || diag?.scores, а сама схема
// diagnostic_agent.md отдаёт "scores"). Если фоллбэка нет — deal.criteria
// в БД никогда не обновляется полем "scores" (только именем
// "criteria_assessment", которого агент не возвращает).
// ---------------------------------------------------------------------
check('bug24_new', 'statePatch.criteria читает и scores, и criteria_assessment (как formatAgentReplyForChat)', () => {
  if (!src.stateMachine) return { pass: false, detail: `не найден файл ${paths.stateMachine}` };
  // Берём окно кода непосредственно ПЕРЕД "statePatch.criteria = {" — туда может
  // входить как прямое условие if(...), так и промежуточная переменная
  // (например const diagForCriteria = a || b; if (diagForCriteria) {...}).
  const idx = src.stateMachine.indexOf('statePatch.criteria = {');
  if (idx === -1) return { pass: false, detail: 'блок присвоения statePatch.criteria не найден — проверить вручную (возможно, изменена структура кода)' };
  const windowBefore = src.stateMachine.slice(Math.max(0, idx - 500), idx);
  const hasFallback = /\|\|/.test(windowBefore) && /scores/.test(windowBefore) && /criteria_assessment/.test(windowBefore);
  return {
    pass: hasFallback,
    detail: hasFallback
      ? 'найден фоллбэк на оба варианта имени поля перед присвоением statePatch.criteria'
      : `в 500 символах перед "statePatch.criteria = {" нет одновременно "criteria_assessment", "scores" и "||". ` +
        `Схема diagnostic_agent.md отдаёт поле "scores" — без фоллбэка deal.criteria в БД не обновится реальным ` +
        `выводом diagnostic-агента (см. Баг №24 в отчёте о находках).`
  };
});

// ---------------------------------------------------------------------
// Баг №19 — регресс "Executive Summary" во встроенных примерах промптов
// ---------------------------------------------------------------------
check('bug19', 'Ни один промпт-файл не содержит "Executive Summary" во встроенных примерах вывода', () => {
  // Различаем два контекста:
  // (а) термин перечислен как ЗАПРЕЩЁННЫЙ в правиле/списке стоп-слов —
  //     это ОК, так и должно быть;
  // (б) термин встречается внутри примера реального вывода агента (email/notes/summary
  //     с готовым текстом) — это регресс бага №19/№8.
  // Эвристика: строка-правило обычно содержит маркеры вида "жаргон", "термин",
  // "запрещ", "стоп-слов", "англицизм" рядом с самим термином.
  const ruleContextMarkers = /жаргон|термин|запрещ|стоп.?слов|англицизм|анлициз/i;
  const offenders = [];
  for (const [name] of Object.entries(paths)) {
    // strategy_agent.md и agentRunner.js намеренно исключены: strategy_agent.md
    // использует "Executive Summary" как легитимный термин типа вложения/касания
    // (не как утёкший англицизм — не тот смысл, что у бага №19), а agentRunner.js
    // не промпт агента и не может "утечь" в вывод менеджеру.
    if (name === 'stateMachine' || name === 'strategy' || name === 'agentRunner') continue;
    const content = src[name];
    if (!content) continue;
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (/executive summary/i.test(line) && !ruleContextMarkers.test(line)) {
        offenders.push(`${name}:${idx + 1}: "${line.trim()}"`);
      }
    });
  }
  return {
    pass: offenders.length === 0,
    detail: offenders.length ? `найдено вне контекста правила:\n   ${offenders.join('\n   ')}` : 'не найдено (упоминания в списках стоп-слов не считаются)'
  };
});

// ---------------------------------------------------------------------
// Баг №29 (найден и пофикшен в сессии 3, продолжение) — рендеринг
// "Обоснование: ..." должен показывать только strategy_summary. Старый
// код "s.rationale ? ... : s.strategy_summary" был формально мёртвой
// веткой (rationale лежит внутри primary_strategy, не на верхнем уровне
// strategy_output, откуда читает s.rationale), но вводил в заблуждение
// и оставался спящим риском на случай, если модель когда-нибудь
// продублирует rationale на верхний уровень. Проверяем, что везде, где
// рендерится "Обоснование:", код читает ТОЛЬКО strategy_summary — без
// условия на .rationale.
// ---------------------------------------------------------------------
check('bug29_rationale_cleanup', 'Рендеринг "Обоснование:" использует только strategy_summary, без мёртвой/вводящей в заблуждение ветки на .rationale', () => {
  if (!src.stateMachine) return { pass: false, detail: `не найден файл ${paths.stateMachine}` };
  const offenders = [];
  src.stateMachine.split('\n').forEach((line, idx) => {
    if (/`Обоснование:/.test(line) && /\.rationale\b/.test(line)) {
      offenders.push(`stateMachine.js:${idx + 1}: "${line.trim()}"`);
    }
  });
  return {
    pass: offenders.length === 0,
    detail: offenders.length
      ? `найдены места, где "Обоснование:" всё ещё завязано на .rationale:\n   ${offenders.join('\n   ')}`
      : 'везде используется только strategy_summary'
  };
});

// ---------------------------------------------------------------------
// Баг №30 (НОВЫЙ, найден при разборе бага №29, пофикшен) — рассогласование
// имени поля: код в case 'STRATEGY_SELECTION' formatAgentReplyForChat()
// читал "s.recommended_next_step", а схема strategy_agent.md ("ВЫХОДНЫЕ
// ДАННЫЕ") отдаёт поле "recommended_next_action". Из-за этого строка
// "Следующий шаг: ..." никогда не показывалась менеджеру — хотя агент
// каждый раз генерирует конкретное следующее действие. Проверяем, что
// код использует ИМЕННО то имя поля, которое реально отдаёт схема агента.
// ---------------------------------------------------------------------
check('bug30_new', 'stateMachine.js читает recommended_next_action (а не recommended_next_step) — как отдаёт схема strategy_agent.md', () => {
  if (!src.stateMachine) return { pass: false, detail: `не найден файл ${paths.stateMachine}` };
  if (!src.strategy) return { pass: false, detail: `не найден файл ${paths.strategy} — не могу сверить со схемой` };
  const schemaHasAction = /"recommended_next_action"\s*:/.test(src.strategy);
  if (!schemaHasAction) {
    return { pass: false, detail: 'strategy_agent.md больше не содержит поля "recommended_next_action" в схеме — проверить вручную, возможно схема изменилась' };
  }
  const codeLines = src.stateMachine.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  const codeUsesWrongName = codeLines.some((l) => /\.recommended_next_step\b/.test(l));
  const codeUsesRightName = codeLines.some((l) => /\.recommended_next_action\b/.test(l));
  if (codeUsesWrongName) {
    return { pass: false, detail: 'stateMachine.js всё ещё читает несуществующее поле .recommended_next_step — "Следующий шаг" никогда не покажется менеджеру (баг №30)' };
  }
  return {
    pass: codeUsesRightName,
    detail: codeUsesRightName
      ? 'stateMachine.js читает .recommended_next_action, совпадает со схемой strategy_agent.md'
      : 'ни .recommended_next_action, ни .recommended_next_step не встречаются в stateMachine.js — "Следующий шаг" сейчас нигде не рендерится, проверить вручную'
  };
});

// ---------------------------------------------------------------------
// Перевод названий стратегий (сессия 3) — словарь STRATEGY_NAME_RU и
// translateStrategyName() существуют, и isDisqualificationStrategy()
// (а не прямое сравнение со строкой) используется для решения о
// дисквалификации сделки — иначе перевод промпта молча ломает эту логику.
// ---------------------------------------------------------------------
check('strategy_translation', 'Есть словарь перевода названий стратегий и isDisqualificationStrategy() используется для решения о дисквалификации', () => {
  if (!src.stateMachine) return { pass: false, detail: `не найден файл ${paths.stateMachine}` };
  const hasDict = /STRATEGY_NAME_RU\s*=\s*{/.test(src.stateMachine);
  const hasFn = /function translateStrategyName/.test(src.stateMachine);
  const hasDisqualFn = /function isDisqualificationStrategy/.test(src.stateMachine);
  // Ищем "живое" сравнение только в НЕ-комментарийных строках — сессия 3
  // как раз оставляет в коде комментарий-объяснение, который дословно
  // содержит старое сравнение как пример ("Раньше код сравнивал
  // getStrategyName(...) === 'Disqualification' напрямую") — это не баг,
  // а документация, её не считаем.
  const codeLines = src.stateMachine.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  const rawCompareInCode = codeLines.some((l) => /getStrategyName\([^)]*\)\s*===\s*['"]Disqualification['"]/.test(l));
  const usesFnNotRawCompare = /isDisqualificationStrategy\(output\.strategy_output\)/.test(src.stateMachine) && !rawCompareInCode;
  const missing = [];
  if (!hasDict) missing.push('STRATEGY_NAME_RU не найден');
  if (!hasFn) missing.push('translateStrategyName() не найден');
  if (!hasDisqualFn) missing.push('isDisqualificationStrategy() не найден');
  if (!usesFnNotRawCompare) missing.push('решение о дисквалификации не использует isDisqualificationStrategy() (или где-то осталось прямое сравнение строки)');
  return { pass: missing.length === 0, detail: missing.length ? missing.join('; ') : 'словарь, функция перевода и защищённая проверка дисквалификации на месте' };
});

// ---------------------------------------------------------------------
// Перевод ключей критериев СОПРАНО (сессия 3) — SOPRANO_CRITERIA_KEY_LABELS
// применяется в обоих местах рендеринга (DIAGNOSING и CONFLICT_RESOLUTION).
// ---------------------------------------------------------------------
check('soprano_key_labels', 'SOPRANO_CRITERIA_KEY_LABELS/translateCriterionKey используется именно в блоках DIAGNOSING и CONFLICT_RESOLUTION', () => {
  if (!src.stateMachine) return { pass: false, detail: `не найден файл ${paths.stateMachine}` };
  const hasDict = /SOPRANO_CRITERIA_KEY_LABELS\s*=\s*{/.test(src.stateMachine);
  if (!hasDict) return { pass: false, detail: 'SOPRANO_CRITERIA_KEY_LABELS не найден' };

  // Достаём тела конкретных case-блоков внутри formatAgentReplyForChat(), а не
  // считаем вызовы translateCriterionKey() по всему файлу — иначе проверка не
  // отличит "перевод есть в обоих нужных местах" от "перевод есть только в
  // одном месте, а второе успело сломаться". Первая версия этой проверки просто
  // считала общее число вызовов (и даже неточно — попадало определение самой
  // функции) — что для конкретики недостаточно.
  function extractCaseBody(caseName) {
    const re = new RegExp(`case '${caseName}':\\s*{([\\s\\S]*?)\\n {4}}\\n`, 'm');
    const m = src.stateMachine.match(re);
    return m ? m[1] : null;
  }
  const diagnosingBody = extractCaseBody('DIAGNOSING');
  const conflictBody = extractCaseBody('CONFLICT_RESOLUTION');
  const missing = [];
  if (diagnosingBody === null) missing.push('не удалось найти тело case \'DIAGNOSING\' (возможно, изменена структура кода)');
  else if (!/translateCriterionKey\(/.test(diagnosingBody)) missing.push('translateCriterionKey() не вызывается внутри case \'DIAGNOSING\'');
  if (conflictBody === null) missing.push('не удалось найти тело case \'CONFLICT_RESOLUTION\' (возможно, изменена структура кода)');
  else if (!/translateCriterionKey\(/.test(conflictBody)) missing.push('translateCriterionKey() не вызывается внутри case \'CONFLICT_RESOLUTION\'');

  return {
    pass: missing.length === 0,
    detail: missing.length ? missing.join('; ') : 'translateCriterionKey() вызывается и внутри DIAGNOSING, и внутри CONFLICT_RESOLUTION'
  };
});

// ---------------------------------------------------------------------
// Задача Б / Баги №25, №26 (сессия 3) — agentRunner.js: compressInput()
// должен обрезать materials.dialog_history (не только correspondence и
// crm_notes), сохраняя ХВОСТ, а не начало, и не подставлять "undefined"
// вместо отсутствующего поля.
// ---------------------------------------------------------------------
check('compressInput_dialog_history', 'compressInput() в agentRunner.js обрезает dialog_history с хвоста и не создаёт мусорный "undefined" — проверка по КАЖДОМУ полю отдельно', () => {
  if (!src.agentRunner) return { pass: false, detail: `не найден файл ${paths.agentRunner}` };
  const fnMatch = src.agentRunner.match(/function compressInput\([\s\S]*?\n}\n/);
  if (!fnMatch) return { pass: false, detail: 'функция compressInput не найдена (возможно, изменена сигнатура)' };
  const body = fnMatch[0];
  const problems = [];
  if (!/dialog_history/.test(body)) problems.push('dialog_history вообще не упоминается в compressInput() — баг №26 регрессировал');
  if (!/\.slice\(-/.test(body)) problems.push('не найдено обрезки с хвоста (slice(-N)) для dialog_history — обрезка может идти с начала, что противоречит фиксу сессии 3');
  // Проверяем typeof-защиту ОТДЕЛЬНО для каждого поля, которое конкатенируется —
  // первая версия этой проверки искала защиту "хоть у какого-то" поля одной
  // общей регуляркой и давала ложный ✅, если защита пропадала только у ОДНОГО
  // конкретного поля (например, только у dialog_history), а у остальных
  // оставалась. Теперь для каждого поля с конкатенацией отдельно требуем
  // именно ЕГО typeof-проверку.
  const fieldsToCheck = [
    { varName: 'originalCorrespondence', label: 'correspondence' },
    { varName: 'originalCrmNotes', label: 'crm_notes' },
    { varName: 'originalDialogHistory', label: 'dialog_history' }
  ];
  for (const { varName, label } of fieldsToCheck) {
    const concatenates = new RegExp(`${varName}\\s*\\.(slice|length)`).test(body) || new RegExp(`${varName}\\s*\\+`).test(body);
    if (!concatenates) continue; // поле не используется в конкатенации — нечего проверять
    const hasGuard = new RegExp(`typeof\\s+${varName}\\s*===\\s*'string'`).test(body);
    if (!hasGuard) {
      problems.push(`поле ${label} (${varName}) используется без явной проверки "typeof ${varName} === 'string'" — риск повтора бага №25 (undefined в промпте) именно для этого поля`);
    }
  }
  return { pass: problems.length === 0, detail: problems.length ? problems.join('; ') : 'dialog_history обрезается с хвоста, все три поля защищены от undefined по отдельности' };
});

// ---------------------------------------------------------------------
// Систематическая проверка языка (сессия 3) — английские кодовые имена
// стратегий не должны утекать в примерах вывода агентов memory/composer/
// reviewer/diagnostic вне контекста таблицы перевода (strategy_agent.md
// сам содержит таблицу — исключён из этой проверки, для него английские
// имена в контексте таблицы легитимны).
// ---------------------------------------------------------------------
check('strategy_name_leak', 'Английские кодовые имена стратегий не встречаются в memory/composer/reviewer/diagnostic вне явного сопоставления с переводом', () => {
  const codeNames = ['StakeholderExpansion', 'RiskReduction', 'EconomicValue', 'DirectConversation', 'SoftNurture', 'TrustBuilding', 'Activation', 'Escalation', 'Disqualification'];
  const filesToCheck = ['memory', 'composer', 'reviewer', 'diagnostic']; // strategy_agent.md намеренно не проверяется — там легитимная таблица перевода
  const offenders = [];
  for (const name of filesToCheck) {
    const content = src[name];
    if (!content) continue;
    content.split('\n').forEach((line, idx) => {
      for (const code of codeNames) {
        if (!line.includes(code)) continue;
        // ВАЖНО: первая версия этой проверки считала легитимным ЛЮБОЕ
        // соседство с кириллицей на той же строке — но именно так выглядел
        // реальный баг сессии 3 (английское имя ВНУТРИ русского предложения,
        // см. memory_agent.md, what_was_done с StakeholderExpansion) —
        // такая строка тоже "содержит кириллицу", так что старая проверка
        // пропустила бы этот баг. Легитимным считаем только ЯВНОЕ
        // сопоставление имя↔перевод:
        //   а) "CodeName (Русский перевод)"          — composer_agent.md
        //   б) "Русский перевод" (CodeName)          — reviewer_agent.md
        //   в) "| CodeName | Русский перевод | ..."   — markdown-таблица
        const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const forwardParen = new RegExp(`${escaped}(?:\\s*/\\s*[A-Za-z]+)?\\s*\\([^)]*[а-яА-ЯёЁ]`).test(line); // "CodeName (Перевод" или "CodeName / OtherName (Перевод1 / Перевод2"
        const backwardParen = new RegExp(`[а-яА-ЯёЁ][^()]*\\(\\s*${escaped}\\s*\\)`).test(line); // "Перевод (CodeName)"
        const tableRow = new RegExp(`\\|\\s*${escaped}\\s*\\|[^|\\n]*[а-яА-ЯёЁ]`).test(line); // "| CodeName | Перевод |"
        const isLegitimate = forwardParen || backwardParen || tableRow;
        if (!isLegitimate) {
          offenders.push(`${name}:${idx + 1}: "${line.trim()}"`);
        }
      }
    });
  }
  return {
    pass: offenders.length === 0,
    detail: offenders.length
      ? `английское название встречается без явного сопоставления с переводом (скобки/таблица) на той же строке:\n   ${offenders.join('\n   ')}`
      : 'английские кодовые имена стратегий нигде не встречаются вне явного сопоставления с переводом'
  };
});

// ---------------------------------------------------------------------
// Баг №31 (НОВЫЙ) — состояние CONFLICT_RESOLUTION было физически
// недостижимо: runIntakeStep() решал, переходить ли туда, по полю
// "conflicts_require_confirmation" — а такого поля НИГДЕ нет в схеме
// diagnostic_agent.md (ни в "ВЫХОДНЫЕ ДАННЫЕ", ни в примерах). Условие
// было всегда false. Реальное поле, которое агент возвращает — это
// массив conflicts_with_manager. Проверяем: (а) выдуманного поля больше
// нет в коде, (б) переход в CONFLICT_RESOLUTION завязан на реальное поле.
// ---------------------------------------------------------------------
check('bug31_conflict_resolution_reachable', 'Переход в CONFLICT_RESOLUTION завязан на реальное поле diagnostic_output.conflicts_with_manager, а не на несуществующее conflicts_require_confirmation', () => {
  if (!src.stateMachine) return { pass: false, detail: `не найден файл ${paths.stateMachine}` };
  if (!src.diagnostic) return { pass: false, detail: `не найден файл ${paths.diagnostic} — не могу сверить со схемой` };
  const schemaHasField = /"conflicts_with_manager"\s*:/.test(src.diagnostic);
  const schemaHasFakeField = /conflicts_require_confirmation/.test(src.diagnostic);
  if (!schemaHasField) return { pass: false, detail: 'diagnostic_agent.md больше не содержит поля "conflicts_with_manager" — проверить вручную, возможно схема изменилась' };
  if (schemaHasFakeField) return { pass: false, detail: 'diagnostic_agent.md теперь ЗНАЕТ про conflicts_require_confirmation — если промпт обновили, проверить вручную, эта проверка могла устареть' };

  const codeLines = src.stateMachine.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  const codeUsesFakeField = codeLines.some((l) => /conflicts_require_confirmation/.test(l));
  const codeUsesRealField = codeLines.some((l) => /conflicts_with_manager\?\.length\s*>\s*0/.test(l));
  if (codeUsesFakeField) {
    return { pass: false, detail: 'stateMachine.js всё ещё проверяет несуществующее поле conflicts_require_confirmation — CONFLICT_RESOLUTION недостижима (баг №31)' };
  }
  return {
    pass: codeUsesRealField,
    detail: codeUsesRealField
      ? 'переход в CONFLICT_RESOLUTION основан на непустом conflicts_with_manager — реальном поле схемы'
      : 'не нашёл ожидаемый паттерн "conflicts_with_manager?.length > 0" — проверить вручную, как сейчас принимается решение о переходе'
  };
});

// ---------------------------------------------------------------------
// Баг №32 (НОВЫЙ) — рендеринг сообщения в состоянии CONFLICT_RESOLUTION
// читал ТОЛЬКО conflicts_explained (несуществующее поле), без фоллбэка на
// conflicts_with_manager — в отличие от кейса DIAGNOSING чуть выше по
// файлу, где такой фоллбэк уже был. Оставалось незамеченным, пока
// состояние было недостижимо (баг №31). Проверяем, что оба места
// рендеринга конфликтов используют одинаковый фоллбэк.
// ---------------------------------------------------------------------
check('bug32_conflict_render_fallback', 'Рендеринг конфликтов в CONFLICT_RESOLUTION имеет тот же фоллбэк на conflicts_with_manager, что и в DIAGNOSING', () => {
  if (!src.stateMachine) return { pass: false, detail: `не найден файл ${paths.stateMachine}` };
  const caseMatch = src.stateMachine.match(/case 'CONFLICT_RESOLUTION':\s*{([\s\S]*?)\n {4}}\n/);
  if (!caseMatch) return { pass: false, detail: 'не удалось найти тело case \'CONFLICT_RESOLUTION\' в formatAgentReplyForChat (возможно, изменена структура кода)' };
  const body = caseMatch[1];
  const hasFallback = /conflicts_explained[^\n]*\|\|[^\n]*conflicts_with_manager/.test(body) || /conflicts_with_manager[^\n]*\|\|[^\n]*conflicts_explained/.test(body);
  const onlyFakeField = /conflicts_explained/.test(body) && !hasFallback;
  return {
    pass: hasFallback,
    detail: hasFallback
      ? 'найден фоллбэк на conflicts_with_manager'
      : onlyFakeField
        ? 'читается только conflicts_explained без фоллбэка на conflicts_with_manager — конфликты не будут показаны менеджеру (баг №32)'
        : 'не нашёл ни conflicts_explained, ни conflicts_with_manager в этом блоке — проверить вручную'
  };
});

// --- Вывод ---
console.log('=== STATIC CHECKS (без вызовов LLM) ===\n');
let failCount = 0;
for (const r of results) {
  const mark = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️ ';
  if (r.status !== 'PASS') failCount++;
  console.log(`${mark} [${r.id}] ${r.title}`);
  console.log(`   ${r.detail}\n`);
}
console.log(`Итого: ${results.length - failCount}/${results.length} пройдено.`);
process.exit(failCount ? 1 : 0);
