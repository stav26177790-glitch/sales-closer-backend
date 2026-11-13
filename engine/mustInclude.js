/**
 * engine/mustInclude.js — «Обязательно в касаниях» для конкретной сделки.
 *
 * Живой тест 2026-11-13 («Кофейня «Зерно»»): правила про логотип, ссылку на
 * прежнее условие по срокам, сдвиг постоянной вывески и текст для пересылки
 * в промпте composer'а были, но затерялись в длинном тексте — composer их
 * пропустил, reviewer одобрил. Теперь список пунктов для ЭТОЙ сделки
 * составляется на этапе стратегии и виден менеджеру до касаний:
 *   - пункты из переписки (обещания клиента, прежние условия менеджера,
 *     пересылка ЛПР, согласие контактного лица) пишет strategy-агент
 *     в `strategy_output.must_include`;
 *   - пункты по срокам добавляет код из `timeline` (модели путают даты).
 * Composer получает список внутри strategy_output, reviewer проверяет каждый
 * пункт (`must_include_check`), а код не даёт одобрить касание, где
 * reviewer отметил пункт невыполненным.
 */
const { humanDate } = require('./timeline');

const MAX_STRATEGY_ITEMS = 6;

function itemText(x) {
  if (typeof x === 'string') return x.trim();
  if (x && typeof x === 'object') return String(x.text || x.item || x.what || '').trim();
  return '';
}

// Пункты по срокам — только из расчёта кодом.
function timelineItems(timeline) {
  if (!timeline || !['не успеваем', 'впритык'].includes(timeline.status)) return [];
  const t = timeline.if_start_today || {};
  const ready = t.installed_earliest === t.installed_latest
    ? humanDate(t.installed_latest)
    : `${humanDate(t.installed_earliest)} – ${humanDate(t.installed_latest)}`;
  const items = [
    `Сроки (расчёт): хотя бы в одном касании честно сказать, что при старте сегодня основной заказ готов ${ready}, и что каждый рабочий день ожидания сдвигает эту дату на рабочий день — поэтому шаг нужен сейчас (подать как заботу о дате клиента, без давления).`
  ];
  const b = timeline.temp_banner;
  if (b && b.fits_client_deadline) {
    items.push(
      `Сроки (расчёт): дата «запустить не позже ${humanDate(b.latest_start_date)}» — только для временной вывески. Не писать её как срок, до которого можно ждать с основным заказом. Касания, которые уходят позже ${humanDate(b.latest_start_date)}, эту дату не называют.`
    );
  }
  return items;
}

// Пункт стратегии про даты готовности / последний день старта — их даёт код.
// Живой тест 2026-11-13: стратегия написала «баннер при старте до 19 ноября
// готов 20–24 ноября» — смешала «старт сегодня» и «старт до 19-го»; composer
// мог бы перенести эту ошибку в касание. Такие пункты отбрасываем.
const MONTH = '(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)';
const TIMELINE_ITEM_RE = new RegExp(`timeline|из расчёта|(готов[а-яё]*|старт[а-яё]*|запуск[а-яё]*)[^.;]*\\d{1,2}([–-]\\d{1,2})?\\s+${MONTH}`, 'i');
function isTimelineItem(text) {
  return TIMELINE_ITEM_RE.test(text);
}

// Итоговый список: пункты стратегии + пункты по срокам, без повторов.
function buildMustInclude(strategyOutput, timeline) {
  const raw = Array.isArray(strategyOutput?.must_include) ? strategyOutput.must_include.map(itemText).filter(Boolean) : [];
  const dropped = timeline ? raw.filter(isTimelineItem) : [];
  if (dropped.length) console.warn(`[mustInclude] Пункты стратегии про даты убраны (даты даёт расчёт): ${dropped.length}`);
  const fromStrategy = raw.filter((x) => !dropped.includes(x)).slice(0, MAX_STRATEGY_ITEMS);
  const all = [...fromStrategy, ...timelineItems(timeline)];
  return [...new Set(all)];
}

// Вписывает итоговый список в strategy_output (его получают composer и reviewer).
function attachMustInclude(strategyOutput, timeline) {
  if (!strategyOutput || typeof strategyOutput !== 'object') return strategyOutput;
  strategyOutput.must_include = buildMustInclude(strategyOutput, timeline);
  return strategyOutput;
}

function unwrapReviewer(reviewerOutput) {
  if (!reviewerOutput || typeof reviewerOutput !== 'object') return null;
  return reviewerOutput.reviewer_output && !reviewerOutput.messages_reviewed ? reviewerOutput.reviewer_output : reviewerOutput;
}

const isDone = (v) => v === true || /^(да|yes|true|выполнен)/i.test(String(v ?? '').trim());

// Невыполненный пункт → касание, где он должен быть, НА ДОРАБОТКУ (поверх
// вердикта reviewer'а), общий вердикт не ОДОБРЕНО. Одобренное касание при
// этом снова попадает в доработку — keepApprovedTouches его не заморозит.
function applyMustIncludeCheck(reviewerOutput, mustInclude, messageCount) {
  const r = unwrapReviewer(reviewerOutput);
  const items = Array.isArray(mustInclude) ? mustInclude : [];
  if (!r || !items.length) return { reviewerOutput, missed: [] };
  const checks = Array.isArray(r.must_include_check) ? r.must_include_check : null;
  if (!checks) {
    console.warn('[mustInclude] reviewer не вернул must_include_check — обязательные пункты не проверены');
    return { reviewerOutput, missed: [] };
  }
  const reviewed = Array.isArray(r.messages_reviewed) ? r.messages_reviewed : (r.messages_reviewed = []);
  const missed = [];
  for (const c of checks) {
    if (!c || isDone(c.done)) continue;
    const idx = Number(c.item) - 1;
    const text = items[idx] || itemText(c.text) || `пункт ${c.item}`;
    let n = Number(c.touchpoint_number);
    if (!(n >= 1) || (messageCount && n > messageCount)) n = 1;
    let m = reviewed.find((x) => Number(x?.touchpoint_number) === n);
    if (!m) { m = { touchpoint_number: n }; reviewed.push(m); }
    m.verdict = m.verdict === 'ПЕРЕСБОРКА' ? m.verdict : 'НА ДОРАБОТКУ';
    m.failed_criteria = [...new Set([...(m.failed_criteria || []), 'must_include'])];
    const fix = `Обязательный пункт сделки: ${text}${c.fix ? ` ${c.fix}` : ''}`;
    m.fix_instructions = [m.fix_instructions, fix].filter(Boolean).join(' ');
    missed.push({ item: idx + 1, touchpoint_number: n });
  }
  if (missed.length && (r.verdict === 'ОДОБРЕНО' || !r.verdict)) r.verdict = 'НА ДОРАБОТКУ';
  return { reviewerOutput, missed };
}

module.exports = { buildMustInclude, attachMustInclude, applyMustIncludeCheck, timelineItems, isTimelineItem };
