/**
 * engine/pipeline.js — общие шаги цепочки агентов, которые используют
 * несколько этапов: вызов агента с восстановлением ответа, сборка входа
 * для composer, итог сессии (memory), приём новой информации
 * (planner → diagnostic).
 */
const { callAgent } = require('../agentRunner');
const db = require('../db');
const { CONFIG } = require('./config');
const { formatFinalSummary } = require('./chat');

// Если agentRunner не смог распарсить ответ модели (например, потому что модель
// обернула JSON в markdown-разметку ```json ... ```), он возвращает
// { raw_output: '...', parse_error: true } вместо нормального объекта.
// Раньше это тихо "протекало" дальше по цепочке: сломанный reviewer_output без
// verdict читался как "не одобрено", composer получал этот мусор как фидбэк и сам
// съезжал в свободный текст вместо JSON. Пытаемся восстановить JSON здесь же —
// снимаем обёртку ```json / ``` и парсим второй раз.
function tryRecoverFromRawOutput(result) {
  if (!result || typeof result !== 'object') return result;
  if (!result.parse_error || typeof result.raw_output !== 'string') return result;
  const cleaned = result.raw_output
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Не получилось (например, ответ действительно оборван) — возвращаем как было,
    // чтобы сработали существующие диагностические заглушки с сырым текстом.
    return result;
  }
}

// Вызов агента + восстановление ответа в обёртке ```json (см. выше).
async function callAgentSafe(agentName, input, maxTokens) {
  return tryRecoverFromRawOutput(await callAgent(agentName, input, maxTokens));
}

// Лимит ответа composer — 8000 токенов: с полем attachment (полный текст
// прикладываемых документов) ответ может включать несколько объёмных
// документов; на 5000 токенах ответ обрезался посреди JSON и парсинг падал
// с parse_error, хотя сама генерация была корректной.
const COMPOSER_MAX_TOKENS = 8000;

// Единый вход для composer. Раньше эта сборка была скопирована в 6 местах
// stateMachine.js. Порядок ключей сохранён: стратегия, история каналов
// (только для первой попытки), фидбэк (для доработок), лимиты длины, номер итерации.
function buildComposerInput(baseInput, deal, { feedback, channelHistory, iteration }) {
  const input = { ...baseInput, strategy_output: deal.last_strategy_output };
  if (channelHistory !== undefined) input.channel_history = channelHistory;
  if (feedback !== undefined) input.previous_composer_feedback = feedback;
  input.message_length_limits = CONFIG.MAX_MESSAGE_LENGTH;
  input.iteration = iteration;
  return input;
}

async function runComposer(baseInput, deal, options) {
  const result = await callAgentSafe('composer', buildComposerInput(baseInput, deal, options), COMPOSER_MAX_TOKENS);
  return result?.composer_output || result;
}

// Запускает memory-агента и сразу собирает читаемый итог сессии.
// Используется во всех точках, где диалог завершается (одобрение, эскалация,
// потерянная сделка, дисквалификация) — чтобы не было промежуточного "пустого" хода,
// на котором раньше показывался сырой JSON.
async function runMemoryUpdate(dealId, baseInput, deal, extra = {}) {
  const strategyOutput = extra.strategy_output || deal.last_strategy_output;
  const composerOutput = extra.composer_output || deal.last_composer_output;
  const reviewerOutput = extra.reviewer_output || deal.last_reviewer_output;
  // Баг №22: diagnostic_output документирован в схеме входных данных
  // memory_agent.md, но фактически никогда не передавался — memory был
  // вынужден сам додумывать patterns_detected по сырому dialog_history,
  // вместо того чтобы скопировать реальную оценку diagnostic-агента.
  const diagnosticOutput = extra.diagnostic_output || deal.last_diagnostic_output;
  const memoryInput = {
    ...baseInput,
    diagnostic_output: diagnosticOutput,
    strategy_output: strategyOutput,
    composer_output: composerOutput,
    reviewer_output: reviewerOutput
  };
  const memoryResult = await callAgentSafe('memory', memoryInput, 6000);
  await db.saveMemory(dealId, memoryResult?.memory_output);
  return formatFinalSummary(memoryResult?.memory_output, strategyOutput, composerOutput, extra.statusNote);
}

// Логика приёма новой информации по сделке: planner → diagnostic → определение
// следующего состояния. Вынесена в отдельную функцию, чтобы её можно было
// вызвать не только из INIT/COLLECTING/SOPRANO_INTERVIEW, но и сразу же
// при старте новой сессии из FINAL_OUTPUT — без лишнего "пустого" хода.
async function runIntakeStep(baseInput, intakeRounds = 1) {
  const output = {};
  // Лимит достигнут — дальше НЕ возвращаемся в SOPRANO_INTERVIEW, даже если
  // planner/diagnostic снова просят уточнение. Оба агента уже отдают полную
  // оценку (scores/criteria_assessment) ДАЖЕ когда clarification_needed.required
  // = true — это не блокирующая ошибка, а их собственный сигнал "было бы
  // лучше уточнить". Проходим дальше с тем, что есть; недостающие критерии
  // и так помечены "Неизвестно" внутри самой оценки agent'ом.
  const roundLimitReached = intakeRounds >= CONFIG.MAX_INTAKE_ROUNDS;
  const plannerResult = await callAgentSafe('planner', baseInput);
  output.planner_output = plannerResult?.planner_output;
  if (plannerResult?.planner_output?.clarification_needed?.required && !roundLimitReached) {
    return { output, nextState: 'SOPRANO_INTERVIEW' };
  }
  const diagnosticResult = await callAgentSafe('diagnostic', { ...baseInput, planner_output: output.planner_output });
  output.diagnostic_output = diagnosticResult?.diagnostic_output || diagnosticResult;
  if (output.diagnostic_output?.clarification_needed?.required && !roundLimitReached) {
    return { output, nextState: 'SOPRANO_INTERVIEW' };
  }
  if (roundLimitReached && (
    plannerResult?.planner_output?.clarification_needed?.required
    || output.diagnostic_output?.clarification_needed?.required
  )) {
    output._intakeRoundLimitNote = `⚠️ Не все детали удалось уточнить за ${CONFIG.MAX_INTAKE_ROUNDS} раунда — ` +
      'диагностика продолжена с доступными данными, недостающие критерии отмечены как "Неизвестно".';
  }
  // Баг №31: раньше здесь проверялось output.diagnostic_output?.conflicts_require_confirmation —
  // поля с таким именем нет НИГДЕ в схеме diagnostic_agent.md (ни в "ВЫХОДНЫЕ
  // ДАННЫЕ", ни в примерах) — агент никогда не знал, что должен его
  // возвращать. Условие было всегда undefined/false, и состояние
  // CONFLICT_RESOLUTION было физически недостижимо: диагностика всегда
  // проваливалась в DIAGNOSING, даже если diagnostic-агент явно нашёл
  // расхождение между самооценкой менеджера и своей оценкой. Источник
  // истины — сам факт непустого conflicts_with_manager (это поле агент
  // реально возвращает и заполняет), а не выдуманный отдельный флаг.
  //
  // 2026-11-12: расхождение — только когда менеджер ДАЛ оценку, а агент с ней
  // не согласен. Агент иногда кладёт в conflicts_with_manager и запись «менеджер
  // не указал оценку» (промпт сам подсказывает так формулировать), а новая
  // сделка создаётся вообще без самооценки — и почти каждая новая сделка
  // уходила в CONFLICT_RESOLUTION с вопросом ни о чём. Такие записи убираем.
  const diag = output.diagnostic_output;
  if (Array.isArray(diag?.conflicts_with_manager) && diag.conflicts_with_manager.length) {
    const real = realManagerConflicts(diag.conflicts_with_manager, baseInput?.materials?.user_assessment);
    if (real.length !== diag.conflicts_with_manager.length) {
      console.warn(
        `[conflicts] Убраны записи без оценки менеджера: ${diag.conflicts_with_manager.length - real.length} ` +
        `(сделка: ${baseInput?.deal?.client || 'unknown_deal'})`
      );
      diag.conflicts_with_manager = real;
    }
  }
  if (output.diagnostic_output?.conflicts_with_manager?.length > 0) {
    return { output, nextState: 'CONFLICT_RESOLUTION' };
  }
  return { output, nextState: 'DIAGNOSING' };
}

const NO_ASSESSMENT = /не\s+указ|не\s+дал|не\s+задан|не\s+заполн|нет\s+оценк|оценк\w*\s+нет|отсутств|неизвестн|^[\s\-—–?]*$/i;

// Записи conflicts_with_manager, где у менеджера действительно есть своя оценка.
function realManagerConflicts(conflicts, userAssessment) {
  const managerGaveAny = Object.values(userAssessment || {}).some((v) => v && String(v).trim());
  if (!managerGaveAny) return [];
  return conflicts.filter((c) => {
    const managerSays = typeof c?.manager_assessment === 'string' ? c.manager_assessment.trim() : '';
    return managerSays && !NO_ASSESSMENT.test(managerSays);
  });
}

module.exports = {
  realManagerConflicts,
  callAgentSafe,
  runComposer,
  runMemoryUpdate,
  runIntakeStep,
};
