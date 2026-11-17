/**
 * Сценарии владельца для критичных ситуаций (engine/scenarios.js, владелец 17.11).
 */
const assert = require('assert');
const { detectScenarios, attachScenarios, checkScenario } = require('../engine/scenarios');
let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }
const ids = (src) => detectScenarios(src).map((s) => s.id).sort();
const addHow = (x, t) => { x.how = [...(x.how || []), t]; };

check('ситуация — по последнему событию', () => {
  assert.deepEqual(ids('Арсен: «Сделаете 650 — и платим 50% сразу, подписываем до пятницы».'), ['torg']);
  assert.deepEqual(ids('Ольга: Игорь Петрович посмотрел КП: дороговато — нам предлагают за 480.'), ['dorogo']);
  assert.deepEqual(ids('Вика: зачем нам какой-то Zoom, просто скиньте цену без логотипа.'), ['just_price']);
  assert.deepEqual(ids('Арсен сказал, что подумает до понедельника. Понедельник прошёл, не перезвонил.'), ['think_silence']);
  assert.deepEqual(ids('Георгий Давидович хочет сначала своими глазами посмотреть, как делают буквы.'), ['want_see']);
  assert.deepEqual(ids('Тамара: Спасибо, покажу Георгию Давидовичу.'), []);
});
check('карточка — в how голосового касания-ответа', () => {
  const steps = [{ channel: 'WhatsApp', kind: 'экспертное' }, { channel: 'Звонок', kind: 'экспертное' }];
  attachScenarios(steps, 'Арсен: «Сделаете 650 — подпишем».', addHow);
  assert.ok(!steps[0].how && /СЦЕНАРИЙ «ТОРГ»/.test(steps[1].how[0]) && /«650 — точно не смогу/.test(steps[1].how[0]));
  assert.deepEqual(steps[1].scenarios, ['torg']);
});
check('проверка ходов: торг без полномочий и уступки — на правку; по сценарию — ок; в мессенджере — позвать к разговору', () => {
  assert.equal(checkScenario('Арсен, давайте подпишем по 690.', ['torg'], { channel: 'Звонок' }).length, 1);
  assert.equal(checkScenario('650 — точно не смогу, у меня таких полномочий нет. Попробую согласовать 5% за наличные, если подписываем до пятницы.', ['torg'], { channel: 'Звонок' }).length, 0);
  assert.equal(checkScenario('По цене удобнее голосом — созвонимся сегодня на 5 минут?', ['torg'], { channel: 'WhatsApp' }).length, 0);
  assert.equal(checkScenario('Пятница прошла, от вас тишина. Что изменилось?', ['think_silence']).length, 1);
  assert.equal(checkScenario('Мы с вами договаривались созвониться после понедельника — как ваше решение?', ['think_silence']).length, 0);
  assert.equal(checkScenario('Я привезу образец прямо к вам.', ['want_see'], { channel: 'Звонок' }).length, 1);
});
check('прогон 6: сценарии — только по последнему сообщению менеджера; тишина вытесняет старые; торг и «посмотреть» — в разные звонки', () => {
  const src = '[Сообщение менеджера 1]\nВика: зачем нам Zoom, просто скиньте цену.\n\n[Сообщение менеджера 2]\nок\n\n[Сообщение менеджера 3]\nПровела Zoom. Арсен: «Сделаете 650 — подписываем до пятницы». Хочет потрогать латунь вживую.';
  assert.deepEqual(ids(src), ['torg', 'want_see']);
  assert.deepEqual(ids(src + '\n\n[Сообщение менеджера 4]\nАрсен обещал подумать до понедельника. Понедельник прошёл, не перезвонил. Сделаете 650 — помним.'), ['think_silence']);
  const steps = [{ channel: 'Звонок' }, { channel: 'WhatsApp' }, { channel: 'Звонок', conditional: true }];
  attachScenarios(steps, src, addHow);
  assert.deepEqual(steps[0].scenarios, ['torg']); assert.deepEqual(steps[2].scenarios, ['want_see']);
});
console.log(`scenarios: ${n} проверок пройдено`);
