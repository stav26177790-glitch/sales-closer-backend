// Понятные менеджеру сообщения об ошибках вместо сырого текста API.
// Исходная ошибка всегда пишется в лог Render (console.error в server.js).

const MESSAGES = {
  balance: 'Закончился баланс сервиса ИИ — сообщите руководителю. Ваше сообщение не потеряно: после пополнения отправьте его ещё раз.',
  auth: 'Сервис ИИ не принял ключ доступа — сообщите руководителю.',
  busy: 'Сервис ИИ сейчас перегружен. Подождите минуту и отправьте сообщение ещё раз.',
  unavailable: 'Сервис временно недоступен. Попробуйте через минуту.',
  generic: 'Что-то пошло не так. Попробуйте ещё раз через минуту; если ошибка повторится — сообщите руководителю.'
};

function classifyError(e) {
  const status = e && (e.status || e.statusCode);
  const text = String((e && e.message) || '').toLowerCase();
  // 402 / «Insufficient Balance» — так DeepSeek сообщает, что кончились деньги на счёте.
  if (status === 402 || text.includes('credit balance') || text.includes('billing') || text.includes('insufficient balance')) return 'balance';
  if (status === 401 || status === 403 || text.includes('x-api-key') || text.includes('authentication_error')) return 'auth';
  if (status === 429 || status === 529 || text.includes('overloaded') || text.includes('rate_limit')) return 'busy';
  if ((status >= 500 && status < 600) || text.includes('connection') || text.includes('timeout') || text.includes('timed out') || text.includes('fetch failed')) return 'unavailable';
  return 'generic';
}

function friendlyError(e) {
  return MESSAGES[classifyError(e)];
}

module.exports = { friendlyError, classifyError, MESSAGES };
