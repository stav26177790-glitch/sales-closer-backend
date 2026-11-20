/**
 * Живой тест владельца 19.11 («Рёбра & Угли», Пятницкая): Зеркало при зелёной формуле, повтор приёма тому же
 * человеку, «фриза нет», безымянный «похожий бизнес».
 */
const assert = require('assert');
const { attachScenarios } = require('../engine/scenarios');
const { findPlanIssues } = require('../engine/planChecks');
const { findBannedPhrases } = require('../engine/phraseCheck');
let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }
const addHow = (x, t) => { x.how = [...(x.how || []), t]; };
const SRC = 'Армен: «Ольга, всё нравится. Сделаете 230 — подписываем завтра».';

check('Доверие закрыто + торг: звонок помечен mirror, без «на моём месте» — на правку', () => {
  const st = [{ touchpoint_number: 1, channel: 'Звонок', kind: 'экспертное' }];
  attachScenarios(st, SRC, addHow, { trustOk: true });
  assert.ok(st[0].mirror && /ПЕРВЫЙ ход в этом звонке «Зеркало»/.test(st[0].how.join(' ')));
  const bad = findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Армен, 230 не смогу, у меня таких полномочий нет.' }], st);
  assert.ok(bad.some((r) => r.fixes.some((f) => /Зеркало/.test(f))));
  const ok = findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Меньше цену я сделать не могу. А вы бы как поступили на моём месте?) Дали бы скидку?' }], st);
  assert.ok(!ok.some((r) => r.fixes.some((f) => /Зеркало/.test(f))));
});
check('без Доверия — Зеркала нет', () => {
  const st = [{ channel: 'Звонок', kind: 'экспертное' }];
  attachScenarios(st, SRC, addHow, { trustOk: false });
  assert.ok(!st[0].mirror);
});
check('приём отработки тому же человеку второй раз — на правку', () => {
  const plan = [1, 4].map((t) => ({ touchpoint_number: t, recipient: 'Армен Гарегинович (владелец)' }));
  const r = findPlanIssues([
    { touchpoint_number: 1, channel: 'Звонок', body: 'Вы хороший переговорщик. А в целом решение вам подходит?' },
    { touchpoint_number: 4, channel: 'Звонок', body: 'Слушайте, ну вы прям крутой переговорщик!) А что кроме цены?' }], plan);
  assert.ok(r.some((x) => x.touchpoint_number === 4 && x.fixes.some((f) => /переговорщик/.test(f))));
});
check('«похожий бизнес уже работает с нашей вывеской» — безымянный кейс', () => {
  const r = findBannedPhrases([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Кстати, похожий бизнес уже работает с нашей вывеской — пришлю фото.' }]);
  assert.ok(r.length);
});
check('итог письмом: «уступка 5%», предоплата 50% без отказа от 70/30, суббота, повторная просьба фото — на правку', () => {
  const src = 'Кристина прислала фото фасада. Армен: «Сделаете 230 — подписываем завтра».';
  const r = findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Резюмирую: 270 750 ₽ с учётом уступки 5% при оплате наличными, предоплата 50%. Созвонимся 21 ноября (сб) в 11:00. Вы присылаете фото фасада — и я фиксирую слот.' }], [{ touchpoint_number: 1 }], src);
  const f = r.flatMap((x) => x.fixes).join(' | ');
  assert.ok(/итоговая сумма/.test(f) && /лестнице/.test(f) && /выходной/.test(f) && /уже прислал/.test(f), f);
});
check('прогон 19.11: «барбершоп похожего формата, которому мы делали», «[фото работы «…»]», «каждый день ожидания его съедает»', () => {
  for (const b of ['Вот барбершоп похожего формата, которому мы делали вывеску', '[фото работы «барбершоп» — из портфолио]', 'Сейчас запас хороший, но каждый день ожидания его съедает.'])
    assert.ok(findBannedPhrases([{ touchpoint_number: 1, channel: 'WhatsApp', body: b }]).length, b);
  assert.ok(!findBannedPhrases([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Делали вывеску для кафе «Капи» — посмотрите.' }]).length);
});
check('деньги письменно: каждое предложение, а не только первое (прогон 19.11, день)', () => {
  const { moneySentences } = require('../engine/planChecks');
  for (const b of ['По цене — давайте обсудим голосом на Zoom. Скажу сразу: 20% так не получится, у меня таких полномочий нет.',
    'По цене без логотипа: посчитаю и пришлю сегодня.', 'КП глянул? По сумме 140 000 попали или не совсем?',
    'Сравнение: что входит в наши 260 000 ₽ и какие вопросы задать по второму предложению.'])
    assert.ok(moneySentences(b).length, b);
  for (const b of ['Цена: 118 000 ₽ с монтажом, без доплат по ходу.', 'По стоимости удобнее голосом: созвонимся сегодня на 5 минут?'])
    assert.ok(!moneySentences(b).length, b);
});
check('письмо для пересылки ЛПР: «что входит в 290 000 ₽», цена, 70/30 — можно; торг там — нет (владелец 20.11)', () => {
  const { moneySentences } = require('../engine/planChecks');
  const page = 'Что входит в 290 000 ₽: буквы, монтаж, согласование. Оплата 70/30.';
  assert.ok(moneySentences(page).length && !moneySentences(page, { forLpr: true }).length);
  assert.ok(moneySentences('Если дорого — подберём вариант под ваш бюджет.', { forLpr: true }).length);
  const r = findPlanIssues([{ touchpoint_number: 1, channel: 'Email', body: 'Сергей, это текст для пересылки владельцу. ' + page }], [{ touchpoint_number: 1, channel: 'Email' }]);
  assert.ok(!r.some((x) => x.fixes.some((f) => /голосом \(правило/.test(f))));
  for (const b of ['По деньгам она как раз в ваши 30 тысяч.', 'Оплату разобьём на части — 70% сейчас, 30% перед отгрузкой.']) assert.ok(moneySentences(b).length, b);
});
check('кейс под тип бизнеса: тот же → смежный → нет (шаг 3, владелец 20.11)', () => {
  const { caseNote } = require('../engine/cases');
  assert.ok(/тип «кафе».*Капи/.test(caseNote('Кофейня «Зерно»')));
  assert.ok(/СМЕЖНЫЙ.*KV/.test(caseNote('Барбершоп «Борода»')));
  assert.ok(/СМЕЖНЫЙ.*Капи/.test(caseNote('Ресторан «Рёбра & Угли»')));
  assert.equal(caseNote('ООО «Ромашка», вывеска'), null);
});
check('шаг 4: упрёк «так и не пришло / не добрались», три вопроса в мессенджере, ЛДПР без вопроса о влиянии', () => {
  for (const b of ['Мы договаривались, что пришлёте фото фасада — оно так и не пришло.', 'Вы не добрались до нас?', 'Помните, Вика обещала прислать макет?'])
    assert.ok(findBannedPhrases([{ touchpoint_number: 1, channel: 'WhatsApp', body: b }]).length, b);
  const q = findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'На какой месяц ориентируетесь? На что смотрите? Как вам в целом?' }], [{ touchpoint_number: 1 }]);
  assert.ok(q.some((x) => x.fixes.some((f) => /один главный вопрос/.test(f))));
  const call = findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'На какой месяц? На что смотрите? Как вам в целом?' }], [{ touchpoint_number: 1, channel: 'Звонок' }]);
  assert.ok(!call.some((x) => x.fixes.some((f) => /один главный вопрос/.test(f))));
  const plan = [{ touchpoint_number: 1, ldpr: true }];
  assert.ok(findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Марина, добрый день! Решение по деньгам принимает Андрей?' }], plan).some((x) => x.fixes.some((f) => /ЛДПР/.test(f))));
  assert.ok(!findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Марина, а если бы выбирали вы — как вам наш вариант?' }], plan).some((x) => x.fixes.some((f) => /ЛДПР/.test(f))));
});
check('шаг 5: догадки о составе чужого КП, «делали короб для барбершопа»; «я покажу производство» — можно', () => {
  for (const b of ['В КП за 105 000 ₽, судя по составу, пластиковый борт.', 'Диоды там, скорее всего, бюджетные.', 'Делали световой короб для барбершопа — пришлю фото.'])
    assert.ok(findBannedPhrases([{ touchpoint_number: 1, channel: 'WhatsApp', body: b }]).length, b);
  assert.ok(!findBannedPhrases([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Делали вывеску для «Капи» — это кафе, тоже в ТЦ.' }]).length);
  // владелец 20.11: «я покажу производство» — от лица компании, допустимо; не придираться
  assert.ok(!findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Приезжайте во вторник — я покажу производство.' }], [{ touchpoint_number: 1, channel: 'Звонок' }]).some((x) => x.fixes.some((f) => /заведующ/.test(f))));
});
check('шаг 5а: образцы — подсказка писателю; дословное копирование образца — на правку, шаблон последнего шанса — нет', () => {
  const { sampleNote, copiedSample } = require('../engine/samples');
  assert.ok(/ОБРАЗЕЦ/.test(sampleNote('last_chance', { voice: false })) && /ОБРАЗЕЦ/.test(sampleNote('ldpr')));
  assert.equal(copiedSample('Ольга, добрый день! Решила финально набрать — скажите как есть: проект актуален? Можете сказать в открытую, что я сделала не так? Мне правда важно — может, мы что-то упустили.'), null);
  assert.equal(copiedSample('Вечером клиенты будут видеть вас с дороги и находить въезд — вывеска работает на вас каждый день.'), 5);
});
check('корень «деньги письменно» (разбор 20.11): план не ставит деньги в письменное касание при доступном голосе', () => {
  const { moneyToVoice } = require('../engine/touchPlan');
  const steps = [
    { channel: 'WhatsApp', criterion: 'ФВ', goal: 'Снять вопрос денег' },
    { channel: 'Мессенджер', goal: 'Закрыть пробелы СОПРАНО: сроки, бюджет, критерии выбора', also: [] },
    { channel: 'Email', goal: 'Дать Алине готовую страницу для владельца: результат, варианты, цена, сроки' },
    { channel: 'Звонок', goal: 'Договориться о замере' }];
  moneyToVoice(steps, false);
  assert.equal(steps[0].channel, 'Звонок');
  assert.ok(!/бюджет/.test(steps[1].goal) && steps[1].how.some((h) => /О деньгах в этом касании не писать/.test(h)));
  assert.ok(/цена/.test(steps[2].goal) && steps[2].how.some((h) => /Страница для пересылки ЛПР/.test(h)));
  const blocked = [{ channel: 'WhatsApp', criterion: 'ФВ', goal: 'Снять вопрос денег' }];
  moneyToVoice(blocked, true);
  assert.equal(blocked[0].channel, 'WhatsApp');
});
check('живой тест 20.11: «из чего складывается» — по позициям КП с фактами, а не «своё производство, ОТК» (вода)', () => {
  const water = 'Давайте объясню, из чего она складывается, можно? В 165 000 ₽ входит: буквы, короб, монтаж. Производство у нас своё — от поставщиков не зависим. Каждую вывеску проверяет ОТК.';
  assert.ok(findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: water }], [{ touchpoint_number: 1, channel: 'Звонок' }]).some((x) => x.fixes.some((f) => /ПОЧЕМУ ИМЕННО ТАКАЯ ЦЕНА/.test(f))));
  // перечень с фактами, но без финала-обоснования — тоже на правку (владелец 20.11)
  const noWhy = 'Давайте объясню, из чего она складывается, можно? Борт гнёт станок, свет — модули ELF, технолог проверяет толщину букв.';
  assert.ok(findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: noWhy }], [{ touchpoint_number: 1, channel: 'Звонок' }]).some((x) => x.fixes.some((f) => /ПОЧЕМУ ИМЕННО ТАКАЯ ЦЕНА/.test(f))));
  const good = 'Давайте объясню, из чего она складывается, можно? Буквы из акрила, борт гнёт станок — ровно, без щелей. Свет — модули ELF, технолог заранее проверяет толщину букв под диоды, тёмных пятен не будет. Замер — специалист исследует фасад, крепёж учтён заранее. Это всё мы закладываем в стоимость. Мы на процессах не экономим — именно поэтому цена такая.';
  assert.ok(!findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: good }], [{ touchpoint_number: 1, channel: 'Звонок' }]).some((x) => x.fixes.some((f) => /ПОЧЕМУ ИМЕННО ТАКАЯ ЦЕНА/.test(f))));
});
check('живой тест 20.11: ответ клиента со «?» внутри — новые факты (перестройка пути), а не вопрос советнику', () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
  const { isNewFacts } = require('../engine/steps/composing');
  assert.ok(isNewFacts('Отправил касание 1. Денис (20.11, WhatsApp): Руслан посмотрел. Говорит дорого — нам за 120 делают то же самое. И спрашивает: вы вообще для барбершопов делали?'));
  assert.ok(!isNewFacts('что ответить на дорого?'));
  assert.ok(!isNewFacts('касание 2 короче'));
});
check('аудит 20.11: [Имя менеджера] — подставляется кодом из «Я — Дмитрий»', () => {
  const { fillManagerName } = require('../engine/autoCompose');
  const o = { messages: [{ body: 'Андрей, добрый день! Это [Имя менеджера] из «Яркой Рекламы».' }] };
  assert.equal(fillManagerName(o, 'Барбершоп. Я — Дмитрий, менеджер.').messages[0].body, 'Андрей, добрый день! Это Дмитрий из «Яркой Рекламы».');
  const k = { messages: [{ body: 'Это [Имя менеджера].' }] };
  assert.equal(fillManagerName(k, 'без имени').messages[0].body, 'Это [Имя менеджера].');
});
check('живой тест 20.11: «да, делали — для барбершопа» без такого кейса; дата шага раньше касания; «правильно понимаю… по рукам?» не зацикливает', () => {
  const f = (b, p = {}) => findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: b }], [{ touchpoint_number: 1, ...p }]).flatMap((x) => x.fixes);
  assert.ok(f('Да, делали. Например, вывеску для барбершопа «[название из портфолио]».').some((x) => /Кейса «барбершоп» у компании нет/.test(x)));
  assert.ok(!f('Делали вывеску для кафе «Капи».').some((x) => /у компании нет/.test(x)));
  assert.ok(f('Предлагаю 26 ноября (чт) в 11:00 — удобно?', { send_date: '2026-11-27' }).some((x) => /раньше даты самого касания/.test(x)));
  assert.ok(!f('Предлагаю 30 ноября (пн) в 11:00 — удобно?', { send_date: '2026-11-27' }).some((x) => /раньше даты/.test(x)));
  assert.ok(!findBannedPhrases([{ touchpoint_number: 1, channel: 'Звонок', body: 'Правильно понимаю, что в целом вам нравится — по рукам? Оформляемся?' }]).length);
});
check('оптимизация 20.11: переписываются только забракованные касания, остальные — дословно', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
  const ar = require('../agentRunner'); const orig = ar.callAgent; let seen = null;
  ar.callAgent = async (name, input) => { seen = input; return { composer_output: { messages: input.touch_plan.map((p) => ({ body: 'NEW ' + p.touchpoint_number })) } }; };
  delete require.cache[require.resolve('../engine/pipeline')];
  const { runComposer } = require('../engine/pipeline');
  const plan = [1, 2, 3].map((n) => ({ touchpoint_number: n, channel: 'WhatsApp', timing: 't', kind: 'экспертное' }));
  const deal = { last_strategy_output: { touch_plan: plan }, last_composer_output: { messages: plan.map((p) => ({ touchpoint_number: p.touchpoint_number, body: 'OLD ' + p.touchpoint_number })) } };
  return runComposer({}, deal, { feedback: {}, only: [2] }).then((out) => {
    ar.callAgent = orig;
    assert.deepEqual(out.messages.map((m) => m.body), ['OLD 1', 'NEW 2', 'OLD 3']);
    assert.ok(seen.touch_plan.length === 1 && seen.rewrite_only[0] === 2);
  });
});
console.log(`live1911: ${n} проверок пройдено`);
