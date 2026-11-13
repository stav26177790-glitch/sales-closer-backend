/**
 * engine/autoFlow.js — путь без остановок (решение владельца 2026-11-13).
 *
 * Менеджер не оценивает качество оценки и стратегии — он отдаёт переписку и
 * сразу получает путь: оценка → стратегия → проверенные касания, каждая часть
 * появляется в чате, как только готова. Останавливаемся только когда Клоузеру
 * нужны факты (уточнения planner'а, расхождение с самооценкой менеджера) или
 * шаг не удался (тогда в чате понятное сообщение, а не тишина).
 *
 * Шаги машины состояний не меняются: после оценки и после стратегии код сам
 * делает тот ход, который раньше делал менеджер словом «ок». Старые сделки,
 * стоящие на любом этапе, работают как раньше.
 */
const { advance } = require('./advance');
const progress = require('./progress');

// Внутренние «ок» для машины состояний. Разные строки — чтобы защита от
// дублей в advance() (одинаковый текст за 15 секунд) их не склеила.
const AUTO_GO = {
  DIAGNOSING: 'стратегию',
  STRATEGY_SELECTION: 'касания'
};
const MAX_AUTO_STEPS = 3;

// Продолжать сами, только если шаг дал свежий нормальный результат.
function shouldAutoContinue(result) {
  if (!result || !result.raw || result.raw._directText) return false;
  if (result.nextState === 'DIAGNOSING') return !!result.raw.diagnostic_output && !result.raw.diagnostic_output.parse_error;
  if (result.nextState === 'STRATEGY_SELECTION') {
    const s = result.raw.strategy_output;
    return !!s && !s.parse_error && !!(s.primary_strategy || (Array.isArray(s.touchpoint_sequence) && s.touchpoint_sequence.length));
  }
  return false;
}

/**
 * Ход менеджера + автопродолжение.
 * addAgentMessage(result) — сохранить ответ шага в чат (вызывается после каждого шага).
 */
async function runPath(dealId, message, addAgentMessage) {
  let result = await advance(dealId, message, { path: true });
  await addAgentMessage(result);
  progress.addPart(dealId);
  for (let i = 0; i < MAX_AUTO_STEPS && shouldAutoContinue(result); i++) {
    progress.setStage(dealId, progress.stageForState(result.nextState));
    result = await advance(dealId, AUTO_GO[result.nextState], { path: true });
    await addAgentMessage(result);
    progress.addPart(dealId);
  }
  return result;
}

module.exports = { runPath, shouldAutoContinue, AUTO_GO };
