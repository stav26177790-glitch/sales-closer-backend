/**
 * engine/planChecks.js — владелец 14.11: «последний шанс» последним касанием;
 * альтернатива подешевле — с логикой компромисса («есть риск», отход от ТЗ).
 */
const assert = require('assert');
const { findPlanIssues, managerGender } = require('../engine/planChecks');

let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }

const plan = [1, 2, 3, 4].map((i) => ({ touchpoint_number: i, last_chance: i === 4 }));

check('«есть ли у меня шанс» не в последнем касании — на доработку', () => {
  const r = findPlanIssues([{ touchpoint_number: 2, body: 'Марина, есть ли у меня реальный шанс на этот проект?' }], plan);
  assert.equal(r.length, 1);
  assert.ok(/только в последнем касании \(4/.test(r[0].fixes[0]));
});
check('последний шанс без просьбы сказать как есть и без обратной связи — на доработку; с обеими — ок', () => {
  assert.equal(findPlanIssues([{ touchpoint_number: 4, body: 'Марина, напоминаю про вывеску.' }], plan).length, 1);
  // Владелец 16.11: одного вопроса мало — нужны и открытость («как есть»), и обратная связь («что я сделал не так»).
  assert.equal(findPlanIssues([{ touchpoint_number: 4, body: 'Марина, скажите как есть: проект ещё актуален? Если нет — не буду больше отвлекать, чтобы не тратить ваше время.' }], plan).length, 1);
  assert.equal(findPlanIssues([{ touchpoint_number: 4, body: 'Марина, скажите как есть: проект ещё актуален? Если нет — можете сказать в открытую, что я сделал не так?' }], plan).length, 0);
});
check('без плана с «последним шансом» вопрос о шансе не трогаем', () => {
  assert.equal(findPlanIssues([{ touchpoint_number: 1, body: 'Скажите как есть — проект актуален?' }], null).length, 0);
});
check('альтернатива подешевле без риска — на доработку (Зерно 7: «скорректировать размер или материал»)', () => {
  const r = findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body: 'Андрей, подберу варианты под ваш бюджет — например, буквы поменьше или пластиковый борт. Посчитаю и пришлю.' }], plan);
  assert.equal(r.length, 1);
  assert.ok(/отход от ТЗ/.test(r[0].fixes[0]));
});
check('альтернатива с риском и отходом от ТЗ — ок', () => {
  const body = 'Андрей, чтобы вы не переплачивали, подберу варианты под ваш бюджет. Скажу честно: это отход от ТЗ. Если уменьшить буквы — вывеску хуже видно издалека; пластиковый борт вместо алюминиевого — есть риск, что прослужит меньше.';
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body }], plan).length, 0);
});
check('Москва, 902-ПП: «буквы без подсветки» — нельзя; не Москва — можно', () => {
  const body = 'Андрей, чтобы вы не переплачивали, подберу варианты под ваш бюджет. Это отход от ТЗ: буквы без подсветки — вечером вывеску не видно.';
  assert.ok(findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body }], plan, 'Открываем кофейню на Покровке').some((h) => /902-ПП/.test(h.fixes.join(' '))));
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body }], plan, 'Предприятие в Тверской области').length, 0);
});
check('Москва, 902-ПП: короб вместо букв — только с инкрустацией', () => {
  const bad = 'Андрей, подберу варианты под ваш бюджет. Это отход от ТЗ: световой короб вместо букв выглядит проще.';
  const ok = 'Андрей, подберу варианты под ваш бюджет. Это отход от ТЗ: световой короб вместо букв по технологии псевдоинкрустации выглядит проще.';
  assert.ok(findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body: bad }], plan, '').some((h) => /инкрустац/.test(h.fixes.join(' '))));
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body: ok }], plan, '').length, 0);
});
check('временная вывеска: в Москве — только «внутри»; не Москва — без требования', () => {
  const t = 'Марина, баннер успевает к открытию — гости найдут вас с первого дня.';
  assert.ok(findPlanIssues([{ touchpoint_number: 1, body: t }], plan, 'кофейня на Покровке').some((h) => /внутри помещения/.test(h.fixes.join(' '))));
  assert.equal(findPlanIssues([{ touchpoint_number: 1, body: 'Марина, временную вывеску поставим внутри, в витрине — успевает к открытию.' }], plan, 'Покровка').length, 0);
  assert.equal(findPlanIssues([{ touchpoint_number: 1, body: t }], plan, 'Магазин в Тверской области').length, 0);
});
check('«каждый день ожидания сдвигает дату» — только в одном касании', () => {
  const r = findPlanIssues([
    { touchpoint_number: 1, body: 'При старте сегодня готово 4 декабря. Каждый рабочий день ожидания сдвигает эту дату.' },
    { touchpoint_number: 3, body: 'Марина, напомню: каждый день задержки сдвигает готовность.' }
  ], plan, '');
  assert.deepEqual(r.map((h) => h.touchpoint_number), [3]);
});
// Владелец 14.11 (правило): всё, что касается денег, — только звонок или Zoom.
check('деньги в мессенджере — на доработку; звонок / Zoom — ок; предложение созвониться — ок; цена КП как факт — ок', () => {
  const t = 'Марина, по бюджету: подберу варианты, чтобы вы не переплачивали.';
  assert.ok(findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: t }], plan, 'Покровка').some((h) => /звонком или в Zoom/.test(h.fixes.join(' '))));
  // Zoom 17.11: сценарий встречи требует ещё температуру и фиксацию (файл 29) — здесь проверяем только «деньги».
  assert.ok(!/звонком или в Zoom/.test(JSON.stringify(findPlanIssues([{ touchpoint_number: 1, channel: 'Zoom', body: t + ' Это отход от ТЗ, есть риск.' }], plan, ''))));
  assert.ok(!findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Марина, по стоимости баннера удобнее голосом — созвонимся сегодня на 5 минут?' }], plan, '').length);
  assert.ok(!findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Андрей, КП на вывеску — 185 000 ₽ с монтажом, цена фиксированная.' }], plan, '').length);
});
check('прогон 15.11 «Fresh Bowl»: «Как обещал в разговоре» у менеджера-женщины — на правку; «Сергей написал» — не про менеджера', () => {
  const src = 'Я (06.11): Отправила КП: 240 000 ₽.';
  assert.ok(findPlanIssues([{ touchpoint_number: 1, channel: 'Email', body: 'Сергей, добрый день! Как обещал в разговоре — отправляю кейс.' }], plan, src)
    .some((h) => /женщина/.test(h.fixes.join(' '))));
  assert.equal(findPlanIssues([{ touchpoint_number: 1, channel: 'Email', body: 'Сергей, добрый день! Как обещала — отправляю кейс. Ксения написала, что вы смотрели КП.' }], plan, src + ' Обещала прислать кейс.').length, 0);
});
check('живой «Fresh Bowl 2», 16.11: WhatsApp написан как звонок — на правку; «рад видеть» у менеджера-женщины — на правку', () => {
  const src = 'Я (06.11): Отправила КП: 240 000 ₽.';
  const wa = (body) => findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body }], plan, src).flatMap((h) => h.fixes).join(' ');
  assert.match(wa('Сергей, добрый день! Ксения передала ваши вопросы — решила сразу вам набрать, чтобы обсудить голосом.\n[пауза]\nПо поводу 20% — таких полномочий у меня нет.'), /написан как звонок/);
  assert.doesNotMatch(wa('Сергей, добрый день! По поводу 20% — таких полномочий у меня нет, но могу попробовать согласовать. Удобно созвониться сегодня в 15?'), /написан как звонок/);
  const call = findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Сергей, добрый день! Не отвлекаю?\n[пауза]' }], plan, src).flatMap((h) => h.fixes).join(' ');
  assert.doesNotMatch(call, /написан как звонок/);
  assert.match(findPlanIssues([{ touchpoint_number: 1, channel: 'Личная встреча', body: 'Сергей, рад видеть! Пойдёмте, покажу цех.' }], plan, src).flatMap((h) => h.fixes).join(' '), /женщина/);
});
check('владелец 16.11 (методика «дорого», тренинг 28): на «дорого» сразу «подберу варианты подешевле» — на правку; сначала прояснить, какое это «дорого»', () => {
  const src = 'Ксения: Сергей посмотрел КП: говорит, дорого.';
  const f = (body) => findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body }], plan, src).flatMap((h) => h.fixes).join(' ');
  assert.match(f('Сергей, подберу варианты под ваш бюджет. Но скажу честно: это отход от ТЗ — если уменьшить буквы, вывеску хуже видно.'), /прояснить, какое это «дорого»/);
  assert.doesNotMatch(f('Сергей, а в целом решение вам подходит? [пауза] Для одних «дорого» — не нужно сейчас, для других — не рассчитывали, третьи хотят поторговаться. У вас какой вариант ближе? [пауза] Если поторговаться — подберу варианты под ваш бюджет. Но скажу честно: это отход от ТЗ — если уменьшить буквы, вывеску хуже видно.'), /прояснить, какое это «дорого»/);
  assert.doesNotMatch(findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Подберу варианты под ваш бюджет. Скажу честно: это отход от ТЗ — вывеску хуже видно.' }], plan, 'КП отправила').flatMap((h) => h.fixes).join(' '), /прояснить/);
});
check('симулятор 16.11 «Дента Плюс»: повтор довода (визуализация, ОТК, образец «вы получаете…») в двух касаниях — на правку; кружок не считаем', () => {
  const src = 'Я (07.11): Отправил КП.';
  const msgs = [
    { touchpoint_number: 1, channel: 'Звонок', body: 'Ольга, давайте я подготовлю визуализацию на фото вашего фасада. Каждая вывеска проходит ОТК до отгрузки.' },
    { touchpoint_number: 2, channel: 'Email', body: 'Ольга, если удобно — подготовлю визуализацию на фото фасада. Своё производство в Щёлково.' },
    { touchpoint_number: 3, channel: 'Кружок', body: 'Ольга, появилась идея по визуализации — можем коротко набраться?' },
    { touchpoint_number: 4, channel: 'WhatsApp', body: 'Ольга, оплату можно разбить 70/30: остаток — перед отгрузкой.' }
  ];
  const hits = findPlanIssues(msgs, plan, src);
  const f2 = (hits.find((h) => h.touchpoint_number === 2) || { fixes: [] }).fixes.join(' ');
  assert.match(f2, /Повтор довода: «визуализация на фасаде» уже был в касании 1/);
  assert.ok(!hits.some((h) => h.touchpoint_number === 3 && /Повтор довода/.test(h.fixes.join(' '))));
  assert.ok(!hits.some((h) => h.touchpoint_number === 4 && /Повтор довода/.test(h.fixes.join(' '))));
  const { repeatedArguments } = require('../engine/planChecks');
  assert.deepEqual(repeatedArguments(msgs).map((r) => [r.touchpoint_number, r.key]), [[2, 'визуализация на фасаде']]);
});
check('владелец 16.11: шаг после «дороговато» — звонок без прояснения, какое «дорого» — на правку; письмо с приглашением созвониться — нет', () => {
  const stepPlan = [{ touchpoint_number: 1, channel: 'Звонок', path_mode: 'step' }];
  const src = 'Ольга (19.11): Игорь Петрович посмотрел КП: говорит, дороговато — нам предлагают за 480 тысяч.';
  const call = findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Ольга, по цене: пришлите КП за 480 тысяч, сравню состав.' }], stepPlan, src).flatMap((h) => h.fixes).join(' ');
  assert.match(call, /прояснить, какое это «дорого»/);
  const ok = findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Ольга, а в целом решение Игорю Петровичу подходит? [пауза] Для одних «дорого» — не нужно сейчас, для других — не рассчитывали, третьи хотят поторговаться. Какой вариант ближе?' }], stepPlan, src).flatMap((h) => h.fixes).join(' ');
  assert.doesNotMatch(ok, /прояснить/);
  const wa = findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Ольга, по цене удобнее голосом — созвонимся сегодня на 5 минут?' }], [{ touchpoint_number: 1, channel: 'WhatsApp', path_mode: 'step' }], src).flatMap((h) => h.fixes).join(' ');
  assert.doesNotMatch(wa, /прояснить/);
});
check('симулятор 16.11: «дата открытия 15 декабря уже прошла» в касании 7 декабря — ошибка; про прошедшую дату — можно', () => {
  const p7 = [{ touchpoint_number: 1, channel: 'Звонок', send_date: '2026-12-07' }];
  const f = (body) => findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body }], p7, 'Я (06.11): Отправила КП.').flatMap((h) => h.fixes).join(' ');
  assert.match(f('Ксения, дата открытия 15 декабря уже прошла — давайте пересчитаем.'), /ещё впереди/);
  assert.doesNotMatch(f('Ксения, срок 25 ноября уже прошёл — честно пересчитала.'), /ещё впереди/);
});
check('владелец 16.11 (вариант 1): касание 1 прошлого хода считаем отправленным — его доводы в новом ходе не повторяем', () => {
  const sent = [{ channel: 'Звонок', body: 'Ольга, давайте я подготовлю визуализацию на фото вашего фасада.' }];
  const msgs = [{ touchpoint_number: 1, channel: 'Звонок', body: 'Ольга, давайте я всё-таки сделаю визуализацию на вашем фасаде.' },
    { touchpoint_number: 2, channel: 'Email', body: 'Оплату можно разбить 70/30: остаток — перед отгрузкой.' }];
  const f1 = findPlanIssues(msgs, plan, 'x', sent).flatMap((h) => h.fixes).join(' ');
  assert.match(f1, /Повтор довода: «визуализация на фасаде» уже был в касании прошлого хода/);
  assert.ok(!findPlanIssues(msgs, plan, 'x', sent).some((h) => h.touchpoint_number === 2));
  assert.equal(findPlanIssues(msgs, plan, 'x', []).length, 0);
  const { sentHistoryAfter } = require('../engine/sentHistory');
  const h = sentHistoryAfter({ messages: [{ touchpoint_number: 2, channel: 'Email', body: 'Б' }, { touchpoint_number: 1, channel: 'Звонок', body: 'А' }], _sent_history: [{ channel: 'WhatsApp', body: 'раньше' }] });
  assert.deepEqual(h.map((x) => x.body), ['раньше', 'А']);
});
check('симулятор 16.11: один довод разным людям (звонок Ольге, письмо для пересылки Игорю Петровичу) — не повтор; тому же человеку — повтор', () => {
  const msgs = [{ touchpoint_number: 1, channel: 'Звонок', body: 'Ольга, добрый день! По оплате: 70% при старте, остаток 30% — после проверки.' },
    { touchpoint_number: 2, channel: 'Email', body: 'Игорь Петрович, добрый день! Оплата частями: 70% при старте, 30% — после проверки готовой вывески.' },
    { touchpoint_number: 3, channel: 'WhatsApp', body: 'Ольга, напомню: 70% при старте, остаток 30% — перед отгрузкой.' }];
  const { repeatedArguments } = require('../engine/planChecks');
  assert.deepEqual(repeatedArguments(msgs).map((r) => [r.touchpoint_number, r.firstIn]), [[3, 1]]);
});
check('владелец 15.11: голос недоступен (не берёт трубку / просит писать) — о деньгах можно в переписке; скидка цифрой — только в финальных касаниях и в обмен', () => {
  const { voiceBlocked } = require('../engine/voice');
  assert.ok(voiceBlocked('клиент не отвечает на звонки'));
  assert.ok(voiceBlocked('Марина (12.11): трубку не беру, пишите сюда — не могу говорить'));
  assert.ok(voiceBlocked('Он не берёт трубку уже неделю'));
  assert.ok(voiceBlocked('попросила писать только в WhatsApp'));
  assert.ok(!voiceBlocked('Марина (31.10): Спасибо, покажу Андрею.'));
  assert.ok(!voiceBlocked('созвонились, обсудили макет'));
  const t = 'Марина, а что именно показалось дорого — сумма в целом или что-то конкретное? В какую сумму хотели бы уложиться?';
  const src = 'Покровка. клиент не отвечает на звонки';
  assert.equal(findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: t }], plan, src).length, 0);
  assert.ok(findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Марина, могу дать скидку 5% при оплате сегодня.' }], plan, src)
    .some((h) => /Скидку цифрой письменно/.test(h.fixes.join(' '))));
  // Финальные касания (3 — перед «последним шансом» 4): скидка цифрой письменно — можно, но в обмен (владелец 15.11).
  assert.equal(findPlanIssues([{ touchpoint_number: 3, channel: 'WhatsApp', body: 'Марина, если заключаем договор на этой неделе — согласую для вас скидку 5%. По рукам?' }], plan, src).length, 0);
  assert.ok(findPlanIssues([{ touchpoint_number: 3, channel: 'WhatsApp', body: 'Марина, могу дать скидку 5%.' }], plan, src)
    .some((h) => /в обмен на шаг/.test(h.fixes.join(' '))));
  // Финальное касание, но голос доступен — нет.
  assert.ok(findPlanIssues([{ touchpoint_number: 3, channel: 'WhatsApp', body: 'Марина, если заключаем договор на этой неделе — скидка 5%.' }], plan, 'Покровка')
    .some((h) => /Скидку цифрой письменно/.test(h.fixes.join(' '))));
  // Без признака — по-прежнему звонком.
  assert.ok(findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: t }], plan, 'Покровка').some((h) => /звонком или в Zoom/.test(h.fixes.join(' '))));
});
check('прогон 14.11: «в понедельник в 10:00 наберу вас» — давление; «удобно, если наберу?» — ок', () => {
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Кружок', body: 'Марина, в понедельник в 10:00 наберу вас.' }], plan, '').length, 1);
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Кружок', body: 'Марина, удобно, если наберу в понедельник утром?' }], plan, '').length, 0);
});
check('правило 73: кружок — интрига + призыв к созвону; идея, кейс, сроки — на правку (владелец 15.11)', () => {
  const plan = [{ touchpoint_number: 3, channel: 'Кружок' }];
  const f = (body) => findPlanIssues([{ touchpoint_number: 3, channel: 'Кружок', body }], plan).length;
  assert.equal(f('Марина, как вы? Решил записать короткое видео в связи с вашим открытием — и у меня появилась идея, уверен, она вас точно заинтересует! Можем коротко набраться — всё объясню по телефону?'), 0);
  assert.equal(f('Марина, привет! Нужно стартовать не позже 19 ноября. Можем созвониться?'), 1, 'срок');
  assert.equal(f('Марина, привет! Делали вывеску для кафе «Капи» — пришлю фото. Созвонимся?'), 1, 'кейс');
  assert.equal(f('Марина, как вы? Появилась идея, уверен, вам понравится!'), 1, 'нет призыва к созвону');
  assert.equal(f('Марина, как вы? ' + 'очень тепло '.repeat(30) + 'Можем коротко набраться?'), 1, 'длинно');
});
check('«по стоимости временной сориентирую отдельно» в письме — не разговор о деньгах (прогон 15.11)', () => {
  const plan = [{ touchpoint_number: 2, channel: 'Email' }];
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Email', body: 'К 1 декабря — временный баннер внутри помещения. По стоимости временной сориентирую отдельно.' }], plan).length, 0);
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Email', body: 'Если дорого — подберём вариант под ваш бюджет.' }], plan).length, 1);
});
check('«не отвлекаю в выходной?» в рабочий день — на правку; в субботу — можно; «из чего складывается цена» в письме — деньги', () => {
  const wed = [{ touchpoint_number: 8, channel: 'Звонок', send_date: '2026-11-25' }];
  const sat = [{ touchpoint_number: 8, channel: 'Звонок', send_date: '2026-11-21' }];
  const body = 'Марина, добрый день! Не отвлекаю в выходной? Скажите как есть: проект ещё актуален?';
  assert.ok(findPlanIssues([{ touchpoint_number: 8, channel: 'Звонок', body }], wed).some((x) => x.fixes.some((f) => /рабочий день/.test(f))));
  assert.ok(!findPlanIssues([{ touchpoint_number: 8, channel: 'Звонок', body }], sat).some((x) => x.fixes.some((f) => /рабочий день/.test(f))));
  assert.equal(findPlanIssues([{ touchpoint_number: 2, channel: 'Email', body: 'Андрей, из чего складывается цена 185 000 ₽: акрил, LED, монтаж.' }], [{ touchpoint_number: 2, channel: 'Email' }]).length, 1);
});
check('два кружка-копии в цепочке — второй на правку; разные поводы — нет', () => {
  const plan = [{ touchpoint_number: 2, channel: 'Кружок' }, { touchpoint_number: 4, channel: 'Кружок' }];
  const a = 'Алина, как вы? Подбирал похожие работы — появилась идея, уверен, она вас точно заинтересует! Можем коротко набраться — всё объясню по телефону?';
  const b = 'Алина, добрый день! Подбирал похожие работы — появилась идея, уверен, она вас точно заинтересует. Можем коротко набраться — всё объясню по телефону?';
  const c = 'Алина, как вы? Решил записать видео в связи с вашим вопросом про буквы 70 см — есть мысль, думаю, понравится. Наберёмся на пару минут — расскажу?';
  const issues = (x, y) => findPlanIssues([{ touchpoint_number: 2, channel: 'Кружок', body: x }, { touchpoint_number: 4, channel: 'Кружок', body: y }], plan);
  assert.deepEqual(issues(a, b).map((x) => x.touchpoint_number), [4]);
  assert.equal(issues(a, c).length, 0);
});
check('кружок раскрывает идею («расскажу, как…») или повторяет идею прошлого кружка — на правку (прогон 15.11, «Нори»)', () => {
  const plan = [{ touchpoint_number: 2, channel: 'Кружок' }, { touchpoint_number: 4, channel: 'Кружок' }];
  const one = (b) => findPlanIssues([{ touchpoint_number: 2, channel: 'Кружок', body: b }], plan.slice(0, 1)).length;
  assert.equal(one('Сергей, как вы? Появилась идея — расскажу, как проверяют подсветку. Наберёмся?'), 1);
  const a = 'Сергей, как вы? Думал, как сделать, чтобы ваша новая вывеска светилась годами без сбоев — появилась идея. Наберёмся?';
  const b = 'Сергей, добрый вечер! Всё думаю про вашу новую вывеску, чтобы светилась годами без сбоев — есть мысль. Созвонимся завтра?';
  const r = findPlanIssues([{ touchpoint_number: 2, channel: 'Кружок', body: a }, { touchpoint_number: 4, channel: 'Кружок', body: b }], plan);
  assert.ok(r.some((x) => x.touchpoint_number === 4 && x.fixes.some((f) => /повторяет/.test(f))));
});
check('«Котик»: род менеджера — по её словам; 902-ПП без Москвы и «пара моментов» — на правку', () => {
  const src = 'После отправки КП котик не отвечает, в бюджет я уложилась, фотопривязку к фасаду сделала';
  assert.equal(managerGender(src), 'f');
  assert.equal(managerGender('Я отправил КП, клиент молчит'), 'm');
  assert.equal(managerGender('Клиент молчит'), null);
  const plan = [{ touchpoint_number: 1, channel: 'Звонок' }, { touchpoint_number: 2, channel: 'Звонок' }];
  const r = findPlanIssues([
    { touchpoint_number: 1, channel: 'Звонок', body: 'Котик, добрый день! Проверял ваш макет по 902-ПП — есть пара моментов. Понял, разобрал.' },
    { touchpoint_number: 2, channel: 'Звонок', body: 'Котик, добрый день! Посмотрела ваш макет по требованиям города, посчитала варианты. Удобно созвониться?' }], plan, src);
  const f1 = r.find((x) => x.touchpoint_number === 1)?.fixes.join(' ') || '';
  assert.ok(/женщина/.test(f1) && /902-ПП — правила Москвы/.test(f1) && /пара моментов/.test(f1));
  assert.ok(!r.some((x) => x.touchpoint_number === 2));
  // Москва в данных — 902-ПП можно.
  const r2 = findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Посмотрела макет по 902-ПП — чтобы не пришлось переделывать. Удобно созвониться?' }], plan, 'кофейня в Москве, я отправила КП');
  assert.ok(!r2.length);
});
// Владелец 16.11 (живой «Дента Плюс»): «последний шанс» — открыто, с напором и сбором обратной связи.
check('«последний шанс» без «что я сделал не так? в открытую» — на правку; с вопросом и обратной связью — ок', () => {
  const lc = [1, 2, 3].map((i) => ({ touchpoint_number: i, last_chance: i === 3 }));
  const bad = findPlanIssues([{ touchpoint_number: 3, channel: 'Звонок', body: 'Ольга, решил финально набрать — скажите как есть: проект актуален? Если нет — не буду больше отвлекать.' }], lc, 'Я (07.11): Отправил КП');
  assert.ok(bad.length && /обратную связь/.test(JSON.stringify(bad)));
  const ok = findPlanIssues([{ touchpoint_number: 3, channel: 'Звонок', body: 'Ольга, решил финально набрать — скажите как есть: проект актуален? [пауза] Если да — давайте договоримся, что нужно, чтобы запуститься до 27 ноября. Если нет — можете сказать в открытую, что я сделал не так? Мне правда важно.' }], lc, 'Я (07.11): Отправил КП');
  assert.equal(ok.length, 0, JSON.stringify(ok));
});
check('живой «Дента Плюс» 16.11: «Я (07.11): Отправил КП», «Созвонился с …» — менеджер мужчина; «Решила набрать», «Записала видео» — на правку', () => {
  const { managerGender } = require('../engine/planChecks');
  assert.equal(managerGender('Я (07.11): Отправил КП: 620 000 ₽'), 'm');
  assert.equal(managerGender('Созвонился с Игорем Петровичем по телефону'), 'm');
  assert.equal(managerGender('Ольга (07.11): Получила, передам. Игорь Петрович посмотрел КП'), null);
  const r = findPlanIssues([{ touchpoint_number: 1, channel: 'Кружок', body: 'Ольга, добрый день! Записала вам короткое видео — появилась идея. Можем коротко набраться?' }], [{ touchpoint_number: 1 }], 'Я (07.11): Отправил КП');
  assert.ok(/мужчина/.test(JSON.stringify(r)), JSON.stringify(r));
});
check('владелец 16.11: «в результате вы получаете» — смысл, не мантра: дословно дважды одному человеку — на правку', () => {
  const { repeatedArguments } = require('../engine/planChecks');
  const msgs = [
    { touchpoint_number: 1, recipient: 'Ольга', body: 'Ольга, в результате вы получаете вывеску к открытию.' },
    { touchpoint_number: 2, recipient: 'Ольга', body: 'Ольга, договоримся сегодня — в результате вы получаете спокойствие.' }
  ];
  assert.ok(JSON.stringify(repeatedArguments(msgs, [], [])).includes('в результате вы получаете'));
  const varied = [msgs[0], { touchpoint_number: 2, recipient: 'Ольга', body: 'Ольга, договоримся сегодня — и вы спокойны за результат.' }];
  assert.ok(!JSON.stringify(repeatedArguments(varied, [], [])).includes('в результате вы получаете'));
});
check('владелец 17.11: касание «Zoom» — сценарий с температурой и фиксацией; без них — на правку', () => {
  const plan = [{ touchpoint_number: 1, channel: 'Zoom' }];
  const bad = findPlanIssues([{ touchpoint_number: 1, channel: 'Zoom', body: 'Георгий Давидович, покажу образцы и расчёт, обсудим детали.' }], plan, 'Я (06.11): Отправила КП');
  assert.ok(/файл 29/.test(JSON.stringify(bad)), JSON.stringify(bad));
  const ok = findPlanIssues([{ touchpoint_number: 1, channel: 'Zoom', body: 'Давайте так: пройдёмся по проекту, покажу варианты и предложу оптимальный — ок? [показ образцов и расчёта] Что вам больше откликнулось? [выслушать] Я правильно поняла, что… Верно? Тогда фиксируем замер на четверг, 11:00.' }], plan, 'Я (06.11): Отправила КП');
  assert.ok(!/файл 29/.test(JSON.stringify(ok)), JSON.stringify(ok));
});
check('живой «Сулико» 17.11: «спросить прямо: проект в приоритете? чтобы я не тратила ваше время» в середине пути — на правку', () => {
  const plan = [1, 2, 3].map((i) => ({ touchpoint_number: i, last_chance: i === 3 }));
  const r = findPlanIssues([{ touchpoint_number: 2, channel: 'Звонок', body: 'Хочу спросить прямо: проект ещё в приоритете у Георгия Давидовича? Если что-то изменилось — скажите, чтобы я не тратила ваше время.' }], plan, 'Я (06.11): Отправила КП');
  assert.ok(/только в последнем касании/.test(JSON.stringify(r)), JSON.stringify(r));
});
check('экзамен 17.11: «к открытию» при «не успеваем» по facts — на правку; при «с запасом» — ок; голос снова доступен после Zoom', () => {
  const body = 'Арсен, решила финально набрать — скажите как есть: проект актуален? Если да — договоримся о шаге, и вывеска будет у вас к открытию 11 декабря. Если нет — можете сказать в открытую, что я сделала не так?';
  const late = findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body }], [{ touchpoint_number: 1, last_chance: true, facts: { status_on_send_day: 'не успеваем', permanent_ready_if_start_that_day: '21–22 декабря' } }], 'Я (09.11): Отправила КП');
  assert.ok(/НЕ успевает/.test(JSON.stringify(late)), JSON.stringify(late));
  const ok = findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body }], [{ touchpoint_number: 1, last_chance: true, facts: { status_on_send_day: 'с запасом' } }], 'Я (09.11): Отправила КП');
  assert.ok(!/НЕ успевает/.test(JSON.stringify(ok)));
  const { voiceBlocked } = require('../engine/voice');
  assert.equal(voiceBlocked('Вика: говорить не могу — пишите сюда.'), true);
  assert.equal(voiceBlocked('Вика: говорить не могу — пишите сюда.\nПровела Zoom с Викой и Арсеном.'), false);
});
check('экзамен 17.11: «временный баннер внутри — успеем к открытию» при «не успеваем» — не нарушение', () => {
  const r = findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Постоянная будет готова 3–4 декабря. Но есть решение: временный баннер внутри, в витрине: при старте до 19 ноября успеем к открытию.' }], [{ touchpoint_number: 1, facts: { status_on_send_day: 'не успеваем', permanent_ready_if_start_that_day: '3–4 декабря' } }], 'Я (31.10): Отправил КП');
  assert.ok(!/НЕ успевает/.test(JSON.stringify(r)), JSON.stringify(r));
});
check('экзамен 17.11: цену клиента ниже КП как согласованную — на правку; «зачем Zoom» → «без Zoom» — на правку', () => {
  const src = 'Я (09.11): Отправила КП: 720 000 ₽ с монтажом.\nАрсен: «Сделаете 650 — и платим 50% сразу, подписываем до пятницы».';
  const f = (body, s = src) => JSON.stringify(findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body }], [{ touchpoint_number: 1 }], s));
  assert.ok(/ниже КП/.test(f('И по цене мы договорились: 650 000 ₽, 50% предоплата. Договор у меня готов.')));
  assert.ok(!/ниже КП/.test(f('650 — точно не смогу, у меня таких полномочий нет. Попробую согласовать небольшую уступку.')));
  const src2 = 'Я (09.11): Отправила КП: 720 000 ₽.\nВика: зачем нам какой-то Zoom, просто скиньте цену без логотипа.';
  assert.ok(/файл 29/.test(f('Я могу сама коротко ответить письменно, без Zoom.', src2)));
});
check('экзамен 17.11: «Разбирался … поговорил» у менеджера-женщины — на правку; «разбиралась» — ок', () => {
  const src = 'Я (09.11): Отправила КП: 720 000 ₽ с монтажом.';
  const f = (body) => JSON.stringify(findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body }], [{ touchpoint_number: 1 }], src));
  assert.ok(/женщина/.test(f('Арсен, добрый день! Разбирался с вашим условием — поговорил с руководителем.')));
  assert.ok(!/женщина/.test(f('Арсен, добрый день! Разбиралась с вашим условием — поговорила с руководителем.')));
});
check('владелец 17.11: кружок-показ материала, который клиент просил увидеть, — ок; с «появилась идея» — на правку', () => {
  const src = 'Я (09.11): Отправила КП.\nАрсен хочет потрогать латунь вживую — ехать некогда.';
  const f = (body) => JSON.stringify(findPlanIssues([{ touchpoint_number: 1, channel: 'Кружок', body }], [{ touchpoint_number: 1 }], src));
  assert.ok(!/Кружок/.test(f('Арсен, добрый день! Вы хотели потрогать латунь — вот она, и вот как светится контражур. Наберёмся сегодня на пару минут?')));
  assert.ok(/без «появилась идея»/.test(f('Арсен, вот латунь и как светится контражур. И появилась идея, уверена, заинтересует. Наберёмся?')));
});
check('судья 17.11 нашёл: «к открытию успеваем с запасом» при «не успеваем» — на правку', () => {
  const r = findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Если стартуем на этой неделе — к открытию успеваем с запасом.' }], [{ touchpoint_number: 1, facts: { status_on_send_day: 'не успеваем', permanent_ready_if_start_that_day: '11–14 декабря' } }], 'Я (09.11): Отправила КП');
  assert.ok(/НЕ успевает/.test(JSON.stringify(r)));
});
check('экзамен 17.11 (прогон 4): «попробую согласовать 650» / «наши 650 — уже уступка» — на правку; «к открытию уже не успеваем» — честно, не нарушение', () => {
  const src = 'Я (09.11): Отправила КП: 720 000 ₽ с монтажом.';
  const f = (body, facts) => JSON.stringify(findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body }], [{ touchpoint_number: 1, facts }], src));
  assert.ok(/не цена клиента/.test(f('У меня таких полномочий нет, но я попробую согласовать 650 с руководством.')));
  assert.ok(/не цена клиента|ниже КП/.test(f('Наши 650 — уже уступка, и она держится, если подписываем.')));
  assert.ok(!/не цена клиента/.test(f('650 — точно не смогу, у меня таких полномочий нет. Попробую согласовать небольшую уступку.')));
  assert.ok(!/НЕ успевает/.test(f('Если запускаемся сегодня — вывеска будет готова 14–15 декабря — к открытию 11 декабря уже не успеваем.', { status_on_send_day: 'не успеваем', permanent_ready_if_start_that_day: '14–15 декабря' })));
});
check('экзамен прогон 5: «по цене 650» голым числом — на правку; «12 рабочих дней», «50%» — нет', () => {
  const src = 'Я (09.11): Отправила КП: 720 000 ₽ с монтажом.';
  const f = (body) => JSON.stringify(findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body }], [{ touchpoint_number: 1 }], src));
  assert.ok(/ниже КП|не цена клиента/.test(f('Если получится — подписываем? Вы получаете вывеску к открытию, по цене 650, с договором.')));
  assert.ok(!/ниже КП|не цена клиента/.test(f('Подписываем до пятницы и вносите 50%? Производство 12 рабочих дней.')));
});
check('шероховатость 5: «как договаривались» без договорённости в переписке — на правку; в условном касании и после созвона — ок', () => {
  const body = 'Арсен, добрый день! Отправляю, как договаривались, похожие работы.';
  const f = (src, p = { touchpoint_number: 1 }) => JSON.stringify(findPlanIssues([{ touchpoint_number: 1, channel: 'Email', body }], [p], src));
  assert.ok(/выдумка/.test(f('Я (09.11): Отправила КП. Тишина.')));
  assert.ok(!/выдумка/.test(f('Я (09.11): Отправила КП. Созвонилась с Арсеном.')));
  assert.ok(!/выдумка/.test(f('Я (09.11): Отправила КП.', { touchpoint_number: 1, condition: 'только если согласится' })));
});
check('прогон 8: «Вы называли 650 000 ₽, я пошла согласовывать с руководителем» — выбивать цену клиента, на правку', () => {
  const r = JSON.stringify(findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body: 'Вы называли 650 000 ₽ и 50% предоплаты, я пошла согласовывать с руководителем. Если получится — подписываем.' }], [{ touchpoint_number: 1 }], 'Я (09.11): Отправила КП: 720 000 ₽ с монтажом.'));
  assert.ok(/не цена клиента|ниже КП/.test(r), r);
});
check('4 экзамена 17.11: одна выгода дословно в двух касаниях одному человеку — на правку; шаблоны владельца и разные люди — нет', () => {
  const { repeatedPhrases } = require('../engine/planChecks');
  const m = (n, body, recipient = 'Тимур') => ({ touchpoint_number: n, recipient, body });
  assert.equal(repeatedPhrases([m(1, 'Тимур, гости с первого дня видят барбершоп с дороги.'), m(2, 'Сделаем быстро — гости с первого дня видят барбершоп.')]).length, 1);
  assert.equal(repeatedPhrases([m(1, 'Тимур, гости с первого дня видят барбершоп с дороги.'), m(2, 'Сделаем быстро — гости с первого дня видят барбершоп.', 'Денис')]).length, 0);
  assert.equal(repeatedPhrases([m(1, 'Как вам в целом такое решение? У меня таких полномочий нет.'), m(2, 'Как вам в целом такое решение? У меня таких полномочий нет.')]).length, 0);
});
check('экзамен 5 17.11: объект в Твери, «Москва» — офис сети; «фасад 7 метров» — не метро → 902-ПП на правку', () => {
  const src = 'Кофейня в Твери, ул. Советская. Фасад 7 метров. Согласует бренд-менеджер сети Ольга (Москва).';
  const r = JSON.stringify(findPlanIssues([{ touchpoint_number: 1, channel: 'WhatsApp', body: 'Ольга, добрый день! Макет проверим по 902-ПП до производства.' }], [], src));
  assert.ok(/902-ПП — правила Москвы/.test(r), r);
});
check('живой тест 18.11: вилка не из данных и «два варианта» без вариантов — на правку; суммы из КП и разница — нет', () => {
  const src = 'Алина: Бюджет — Марат говорит до 100 тысяч. Я: Отправила КП: 128 000 ₽.';
  const run = (b) => JSON.stringify(findPlanIssues([{ touchpoint_number: 1, channel: 'Telegram', body: b }], [], src));
  assert.ok(/не из данных сделки/.test(run('Алина, обычно такие вывески 110–140 тысяч под ключ.')));
  assert.ok(!/не из данных сделки/.test(run('Алина, КП — 128 000 ₽; до вашего бюджета 100 тысяч разница 28 тысяч.')));
  assert.ok(/вариантов нет/.test(run('Алина, собрала всё на одну страницу: там два варианта и цена.')));
  assert.ok(!/вариантов нет/.test(run('Алина, могу подготовить два варианта под бюджет — сделать?')));
});
check('живой тест 18.11: «как обещала» без обещания — выдумка; с обещанием в переписке — ок', () => {
  const body = 'Марат, добрый день! Подготовила варианты под ваш бюджет, как обещала.';
  const run = (src) => JSON.stringify(findPlanIssues([{ touchpoint_number: 1, channel: 'Звонок', body }], [], src));
  assert.ok(/обещания в переписке/.test(run('Алина: вы мне надоели!!! Я сказала — дорого.')));
  assert.ok(!/обещания в переписке/.test(run('Я: Сказала Марату, что уточню и вернусь до 18:00.')));
});
console.log(`planChecks: ${n} проверок пройдено`);
