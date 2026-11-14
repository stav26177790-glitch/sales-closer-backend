/**
 * Этап DIAGNOSING — диагностика показана менеджеру.
 * «ок» / «давай стратегию» → выбираем стратегию. Иначе сообщение менеджера —
 * правка или новые факты: оценка пересобирается с их учётом (живой тест
 * 2026-11-13: «перепиши оценку с учётом сроков» молча запускало стратегию).
 * Потерянная или неквалифицированная сделка сразу закрывает сессию итогом.
 */
const { callAgentSafe, runMemoryUpdate, cleanManagerConflicts } = require('../pipeline');
const { isDisqualificationStrategy } = require('../chat');
const { attachMustInclude } = require('../mustInclude');
const { buildTouchPlan } = require('../touchPlan');
const { cleanStrategy } = require('../strategyCleanup');
const { isGoAhead } = require('../intent');

// Стратегия по текущей оценке (+ правка менеджера к прошлой стратегии, если есть).
async function runStrategy({ dealId, deal, baseInput }, correction) {
  const output = {};
  const input = { ...baseInput, diagnostic_output: deal.last_diagnostic_output };
  if (correction) {
    input.manager_correction = correction;
    input.previous_strategy_output = deal.last_strategy_output;
  }
  // 8000: после перестройки стратегия отдаёт шаги плана с полями (day, condition,
  // recipient…) — на 4000 ответ обрезался и не разбирался (живой «Зерно 5», 2026-11-13).
  const strategyResult = await callAgentSafe('strategy', input, 8000);
  output.strategy_output = strategyResult?.strategy_output || strategyResult;
  // Ответ не разобран — не показываем пустую стратегию как настоящую.
  const s = output.strategy_output;
  if (!s || typeof s !== 'object' || s.parse_error || !(s.primary_strategy || (Array.isArray(s.touchpoint_sequence) && s.touchpoint_sequence.length))) {
    console.warn('[strategy] Ответ стратегии не разобран — стратегия не обновлена');
    if (correction && deal.last_strategy_output) {
      return { nextState: 'STRATEGY_SELECTION', output: { _directText: '⚠️ Не получилось пересобрать стратегию: ответ модели не разобрался. Стратегия осталась прежней — напишите правку ещё раз.' } };
    }
    return { nextState: 'DIAGNOSING', output: { _directText: '⚠️ Не получилось составить стратегию: ответ модели не разобрался. Напишите «ок» ещё раз.' } };
  }
  // «Обязательно в касаниях»: пункты стратегии + пункты по срокам из расчёта кодом.
  cleanStrategy(output.strategy_output);
  attachMustInclude(output.strategy_output, baseInput.timeline, baseInput.materials?.source_materials?.text);
  // План касаний: даты, факты на день отправки, чередование, пункты по касаниям — кодом.
  if (output.strategy_output && typeof output.strategy_output === 'object') {
    const plan = buildTouchPlan(output.strategy_output, baseInput.timeline, baseInput.today, deal.last_diagnostic_output?.scores, { source: baseInput.materials?.source_materials?.text, client: deal.client });
    if (plan) output.strategy_output.touch_plan = plan;
  }

  if (output.strategy_output?.deal_health === 'потеряна') {
    output._finalText = await runMemoryUpdate(dealId, baseInput, deal, {
      strategy_output: output.strategy_output,
      statusNote: 'Статус: сделка отмечена как потерянная.'
    });
    return { nextState: 'FINAL_OUTPUT', output };
  }
  // primary_strategy бывает строкой или объектом, название — русским или
  // старым английским: всё это учитывает isDisqualificationStrategy().
  if (isDisqualificationStrategy(output.strategy_output)) {
    output._finalText = await runMemoryUpdate(dealId, baseInput, deal, {
      strategy_output: output.strategy_output,
      statusNote: 'Статус: сделка не квалифицирована.'
    });
    return { nextState: 'FINAL_OUTPUT', output };
  }
  return { nextState: 'STRATEGY_SELECTION', output };
}

async function diagnosing(ctx) {
  const { deal, baseInput, managerInput } = ctx;
  if (!isGoAhead(managerInput)) {
    const output = {};
    const result = await callAgentSafe('diagnostic', {
      ...baseInput,
      manager_correction: managerInput,
      previous_diagnostic_output: deal.last_diagnostic_output
    });
    output.diagnostic_output = result?.diagnostic_output || result;
    cleanManagerConflicts(output.diagnostic_output, baseInput);
    return { nextState: 'DIAGNOSING', output };
  }
  return runStrategy(ctx);
}

module.exports = { diagnosing, runStrategy };
