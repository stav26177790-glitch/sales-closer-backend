/**
Повторы между ходами (владелец 16.11, вариант 1): касание 1 прошлого хода считаем отправленным — его доводы
в новом ходе не повторяем. Остальные касания прошлого плана могли не уйти — не учитываем. История — в
сохранённых касаниях сделки (`_sent_history`), без новой колонки в базе.
*/
function sentHistoryAfter(prev) {
  const msgs = Array.isArray(prev?.messages) ? prev.messages : [];
  const first = msgs.slice().sort((a, b) => Number(a?.touchpoint_number ?? 99) - Number(b?.touchpoint_number ?? 99))[0];
  const hist = Array.isArray(prev?._sent_history) ? prev._sent_history : [];
  return first?.body ? [...hist, { channel: first.channel || '', body: String(first.body) }].slice(-6) : hist;
}

module.exports = { sentHistoryAfter };
