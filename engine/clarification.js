// Planner останавливается на вопросы, только когда материала нет совсем. Прогон DeepSeek
// (16 ситуаций, 15.11): на 6 сделках с полной перепиской planner просил «оцените клиента по
// 5 критериям», «есть ли срок», «обсуждался ли бюджет» — и путь не строился. Самооценка
// менеджера в Клоузере не используется, срок — в шапке сделки, остальное выясняют касания.
const SOURCE_ENOUGH = 300; // символов материала — уже есть, с чем работать
function dropNeedlessClarification(plannerOutput, baseInput) {
  const c = plannerOutput?.clarification_needed;
  if (!c?.required) return;
  const m = baseInput?.materials || {};
  const src = [m.source_materials?.text, m.correspondence, m.crm_notes, m.call_transcript]
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x || ''))).join(' ');
  if (src.replace(/\s+/g, ' ').trim().length >= SOURCE_ENOUGH) {
    c.required = false;
    c.dropped_questions = c.questions || [];
    c.questions = [];
  }
}

module.exports = { dropNeedlessClarification, SOURCE_ENOUGH };
