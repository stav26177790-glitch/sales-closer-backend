/**
 * stateMachine.js — точка входа машины состояний Клоузера.
 *
 * Логика разнесена по папке engine/ (шаг 3 дорожной карты, 2026-11-11):
 *   engine/advance.js     — один ход: контекст, выбор этапа, запись в базу, очередь
 *   engine/steps/*.js     — по файлу на этап сделки (intake, composing, escalation…)
 *   engine/pipeline.js    — общие вызовы агентов (composer, memory, planner→diagnostic)
 *   engine/chat.js        — тексты для менеджера
 *   engine/intent.js      — распознавание ответа менеджера (ок / правка / вопрос / да-нет)
 *   engine/config.js      — лимиты
 * Файл оставлен, чтобы server.js и тесты подключали машину как раньше.
 */
module.exports = require('./engine/advance');
