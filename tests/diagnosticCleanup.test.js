/** Текст оценки: совет обойти контактное лицо убирается кодом (живые «Зерно 4/5»). */
const assert = require('assert');
const { cleanSummary, ensureBudgetRecommendation, ensureAlternativesRecommendation } = require('../engine/diagnosticCleanup');
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
check('«Это решение нужно предложить Андрею напрямую, не через Марину.» — убрано', () => {
  const t = 'Есть выход — временный баннер к открытию. Это решение нужно предложить Андрею напрямую, не через Марину.\nДоверие к Марине есть.';
  const r = cleanSummary(t);
  assert.ok(!/не через Марину/.test(r.text));
  assert.ok(r.text.includes('временный баннер') && r.text.includes('Доверие к Марине есть'));
});
check('«ситуация требует его решения сейчас, а не через Марину» — убрано', () => {
  assert.ok(!/не через/.test(cleanSummary('Это аргумент для выхода на Андрея: ситуация требует его решения сейчас, а не через Марину. Приоритет — сроки.').text));
});
check('«через Марину или напрямую» → «или напрямую — с её согласия»', () => {
  assert.ok(cleanSummary('Приоритет: выйти на Андрея — через Марину или напрямую.').text.includes('или напрямую — с её согласия'));
});
check('«Второй блокер — срочность» → ЗС; обычный текст не трогаем', () => {
  assert.ok(cleanSummary('Второй блокер — срочность. Дедлайн прошёл.').text.startsWith('Второй блокер — ЗС (здесь и сейчас)'));
  const plain = 'Главный блокер — ЛПР. Марина собирает варианты.';
  assert.equal(cleanSummary(plain).text, plain);
});
check('«дороговато» в переписке, бюджета в рекомендациях нет — код добавляет рекомендацию про бюджет (СОПРАНО: Ограничения)', () => {
  const d = { soprano_recommendations: ['Уточнить критерии выбора', 'Спросить про конкурентов', 'Как Андрей решает'] };
  assert.equal(ensureBudgetRecommendation(d, 'Марина (16.11): Андрей говорит дороговато'), true);
  assert.equal(d.soprano_recommendations.length, 3);
  assert.ok(/бюджет/i.test(d.soprano_recommendations[0]));
  // уже есть про бюджет — не дублируем; нет возражения по цене — не трогаем
  assert.equal(ensureBudgetRecommendation(d, 'дороговато'), false);
  const e = { soprano_recommendations: [] };
  assert.equal(ensureBudgetRecommendation(e, 'Спасибо, покажу Андрею'), false);
});
check('СОПРАНО «Аналоги» не собраны — рекомендация про альтернативы (после бюджета); собраны — нет', () => {
  const d = { soprano: { 'А': { status: 'нет' } }, soprano_recommendations: ['Бюджет (СОПРАНО: Ограничения): уточнить', 'Кто делал первую точку', 'Смотрят ли других'] };
  assert.equal(ensureAlternativesRecommendation(d), true);
  assert.equal(d.soprano_recommendations.length, 3);
  assert.ok(/бюджет/i.test(d.soprano_recommendations[0]));
  assert.ok(/пожертвовать/.test(d.soprano_recommendations[1]));
  assert.equal(ensureAlternativesRecommendation(d), false);
  assert.equal(ensureAlternativesRecommendation({ soprano: { 'А': { status: 'собрано' } }, soprano_recommendations: [] }), false);
});
check('владелец 15.11 (живой «Fresh Bowl»): торг с условием покупки → ФВ Подтверждено; ЛПР вышел на контакт → ЛПР Подтверждено; «понравились работы» → Д Вероятно', () => {
  const { ensureEvidenceScores } = require('../engine/diagnosticCleanup');
  const mk = () => ({ scores: { financial: { status: 'Риск' }, authority: { status: 'Риск' }, trust: { status: 'Риск' } } });
  const base = 'Общаюсь с маркетологом Ксенией. Решение по деньгам и подрядчику принимает собственник Сергей, его контакта у меня нет.';
  let d = mk(); assert.deepEqual(ensureEvidenceScores(d, base + '\nКсения: Сергей посмотрел КП: говорит, дорого, другие предлагают на 15% дешевле.'), []);
  d = mk(); const step3 = base + '\nКсения: Сергей готов созвониться в Zoom в понедельник. Но сказал так: сделаете на 20% дешевле — подпишем сразу.';
  assert.deepEqual(ensureEvidenceScores(d, step3), ['financial', 'authority']);
  assert.equal(d.scores.financial.status, 'Подтверждено'); assert.match(d.scores.financial.evidence[0], /деньги есть/);
  d = mk(); assert.deepEqual(ensureEvidenceScores(d, step3 + '\nСозвонились в Zoom: Сергею понравились наши работы, про скидку сказал «подумаю». С тех пор три дня тишина.'), ['financial', 'authority', 'trust']);
  // Котик: «на 20 процентов дешевле, сделаете на 30 — закажу у вас»
  d = mk(); assert.deepEqual(ensureEvidenceScores(d, 'он сказал, что уже написал — на 20 процентов дешевле, сделаете на 30 — закажу у вас'), ['financial']);
  // После факта — отказ: не поднимаем.
  d = mk(); assert.deepEqual(ensureEvidenceScores(d, 'сделаете на 10% дешевле — подпишем. Потом написал: выбрали других.'), []);
  // Не понижаем.
  d = { scores: { financial: { status: 'Подтверждено' }, authority: { status: 'Риск' }, trust: { status: 'Вероятно' } } };
  assert.deepEqual(ensureEvidenceScores(d, 'сделаете на 10% дешевле — подпишем'), []);
});
check('принцип 15.11: стратег получает «уже случилось» (deal_events) — встреча была, ЛПР на связи, торг, понравилось', () => {
  const { ensureEvidenceScores } = require('../engine/diagnosticCleanup');
  const d = { scores: { financial: { status: 'Риск' }, authority: { status: 'Риск' }, trust: { status: 'Риск' } } };
  ensureEvidenceScores(d, 'Решение принимает собственник Сергей.\nКсения: Сергей готов созвониться в Zoom. Сделаете на 20% дешевле — подпишем сразу.\nСозвонились в Zoom: Сергею понравились наши работы, про скидку сказал «подумаю».');
  const e = d.deal_events.join(' | ');
  assert.match(e, /торгуется с условием покупки/); assert.match(e, /уже состоялись/); assert.match(e, /уже на прямом контакте/); assert.match(e, /понравилось/);
  const d2 = { scores: { financial: { status: 'Риск' } } }; ensureEvidenceScores(d2, 'КП отправила, тишина.');
  assert.equal(d2.deal_events, undefined);
});
check('владелец 16.11: СОПРАНО по фактам — негативный опыт → Опыт и Проблемы собраны; альтернатива → Аналоги собраны, рекомендация про Аналоги уходит', () => {
  const { ensureSopranoFromFacts } = require('../engine/diagnosticCleanup');
  const d = { soprano: { 'О1': { status: 'частично' }, 'П': { status: 'нет' }, 'А': { status: 'нет' } },
    soprano_recommendations: ['Альтернативы (СОПРАНО: Аналоги): уточнить…', 'Уточнить бюджет'] };
  assert.deepEqual(ensureSopranoFromFacts(d, 'В прошлый раз мы сильно обожглись с подрядчиком: через три месяца половина букв погасла.'), ['О1', 'П']);
  assert.equal(d.soprano['П'].status, 'собрано');
  assert.deepEqual(ensureSopranoFromFacts(d, 'Сергей говорит, дорого, другие предлагают на 15% дешевле.'), ['А']);
  assert.deepEqual(d.soprano_recommendations, ['Уточнить бюджет']);
  assert.deepEqual(ensureSopranoFromFacts({ soprano: { 'П': { status: 'нет' } } }, 'КП отправила, тишина.'), []);
  // симулятор 16.11 «Дента Плюс»: «нам предлагают за 480 тысяч» — тоже аналог
  assert.deepEqual(ensureSopranoFromFacts({ soprano: { 'А': { status: 'частично' } } }, 'Игорь Петрович говорит, дороговато — нам предлагают за 480 тысяч.'), ['А']);
});
check('живой тест 18.11: бюджет ниже КП — ФВ «Вероятно»; ЛПР назван, контакт сотрудничает — «Вероятно»; «денег нет» / разрыв в разы — без подъёма', () => {
  const { ensureEvidenceScores } = require('../engine/diagnosticCleanup');
  const mk = () => ({ scores: { financial: { status: 'Риск' }, need: { status: 'Подтверждено' }, trust: { status: 'Неизвестно' }, authority: { status: 'Риск' }, urgency: { status: 'Неизвестно' } } });
  let d = mk();
  ensureEvidenceScores(d, 'Второй совладелец — Марат, он отвечает за деньги. Алина: Бюджет — Марат говорит до 100 тысяч, решает он. Я: Отправила КП: 128 000 ₽.', null);
  assert.equal(d.scores.financial.status, 'Вероятно');
  assert.equal(d.scores.authority.status, 'Вероятно');
  d = mk();
  ensureEvidenceScores(d, 'Бюджет до 100 тысяч. Отправила КП: 300 000 ₽.', null);
  assert.equal(d.scores.financial.status, 'Риск');
  d = mk();
  ensureEvidenceScores(d, 'Бюджет был 100 тысяч, но денег нет — заморозили. Решает он, но ему не надо звонить.', null);
  assert.equal(d.scores.financial.status, 'Риск');
  assert.equal(d.scores.authority.status, 'Риск');
});
console.log(`diagnosticCleanup: ${n} проверок пройдено`);
