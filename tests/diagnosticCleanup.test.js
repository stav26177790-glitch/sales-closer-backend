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
console.log(`diagnosticCleanup: ${n} проверок пройдено`);
