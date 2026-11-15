const assert = require('assert');
// pipeline тянет db.js, который создаёт клиента Supabase при загрузке — в тесте сети нет.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';
const { findBannedPhrases, applyPhraseCheck } = require('../engine/phraseCheck');
const { keepApprovedTouches } = require('../engine/pipeline');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const msgs = [
  { touchpoint_number: 1, body: 'Производство своё, от поставщиков не зависим — дату держим.' },
  { touchpoint_number: 2, body: 'Производство у нас своё, поэтому сроки зависят только от нас.' }
];

check('находит «зависят только от нас», не трогает нормальный текст', () => {
  const hits = findBannedPhrases(msgs);
  assert.deepEqual(hits.map((h) => h.touchpoint_number), [2]);
});

check('одобрение reviewer\'а снимается, если есть запрещённая фраза', () => {
  const r = { verdict: 'ОДОБРЕНО', messages_reviewed: [
    { touchpoint_number: 1, verdict: 'ОДОБРЕНО' }, { touchpoint_number: 2, verdict: 'ОДОБРЕНО' }] };
  applyPhraseCheck(r, msgs);
  assert.equal(r.verdict, 'НА ДОРАБОТКУ');
  assert.equal(r.messages_reviewed[0].verdict, 'ОДОБРЕНО');
  assert.equal(r.messages_reviewed[1].verdict, 'НА ДОРАБОТКУ');
  assert.ok(r.messages_reviewed[1].fix_instructions.includes('поставщиков'));
});

check('одобренное касание с запрещённой фразой не замораживается при доработке', () => {
  const reviewer = { messages_reviewed: [
    { touchpoint_number: 1, verdict: 'ОДОБРЕНО' }, { touchpoint_number: 2, verdict: 'ОДОБРЕНО' }] };
  const fresh = { messages: [{ touchpoint_number: 1, body: 'новый 1' }, { touchpoint_number: 2, body: 'новый 2' }] };
  const { output, kept } = keepApprovedTouches(fresh, { messages: msgs }, reviewer);
  assert.deepEqual(kept, [1]);
  assert.equal(output.messages[1].body, 'новый 2');
});

check('упрёк «вы говорили, что пришлёте» ловится, шаблон владельца — нет', () => {
  const bad = [{ touchpoint_number: 1, body: 'Марина, добрый день.\nВы говорили, что пришлёте логотип — он нужен для макета.' }];
  const good = [{ touchpoint_number: 1, body: 'Помните, мы проговаривали, что пришлёте логотип? Скинете сейчас — сразу отдам дизайнеру, и вы получите готовую визуализацию.' }];
  assert.deepEqual(findBannedPhrases(bad).map((h) => h.touchpoint_number), [1]);
  assert.equal(findBannedPhrases(good).length, 0);
  assert.ok(findBannedPhrases(bad)[0].fixes[0].includes('Помните, мы проговаривали'));
});

check('свежий монтаж без названия — можно (владелец 15.11); с названием клиента — выдуманный кейс', () => {
  const ok = [
    { touchpoint_number: 4, body: 'Пока ждал ответа — смонтировали кофейню очень похожего формата: объёмные буквы на козырьке.' },
    { touchpoint_number: 5, body: 'Вчера как раз смонтировали вывеску для пекарни, как у вас.' }];
  const bad = [{ touchpoint_number: 4, body: 'Вчера смонтировали вывеску для кофейни «Бодрый день» на Тверской.' }];
  assert.equal(findBannedPhrases(ok).length, 0);
  assert.deepEqual(findBannedPhrases(bad).map((h) => h.touchpoint_number), [4]);
});

check('живой «Зерно 4»: угроза «слот уйдёт» и «нужно решение сегодня» ловятся', () => {
  const bad = [
    { touchpoint_number: 3, body: 'макет нужно согласовать до 19 ноября — иначе слот в производственном плане уйдёт и дата сдвинется.' },
    { touchpoint_number: 5, body: 'Постоянная вывеска — следом. Нужно решение Андрея сегодня.' }];
  assert.deepEqual(findBannedPhrases(bad).map((h) => h.touchpoint_number), [3, 5]);
  assert.equal(findBannedPhrases([{ touchpoint_number: 1, body: 'Согласуем макет сейчас — держим за вами ближайший слот, и дата не сдвинется.' }]).length, 0);
});
check('Зерно 6: «если решение по баннеру не принято до конца сегодня — … без вывески совсем» — давление', () => {
  const hits = findBannedPhrases([{ touchpoint_number: 4, body: 'Если решение по баннеру не принято до конца сегодня — к 1 декабря он уже не успеет, и открытие пройдёт без вывески совсем.' }]);
  assert.ok(hits.length >= 1);
  // честный факт о дате без давления — можно
  assert.equal(findBannedPhrases([{ touchpoint_number: 4, body: 'Сегодня последний день, когда баннер успевает к открытию. Если актуально — напишите «да».' }]).length, 0);
});

check('Зерно 7: кружок «Вот, смотрите — похожая вывеска, которую мы делали» ловится', () => {
  assert.equal(findBannedPhrases([{ touchpoint_number: 3, body: 'Марина, добрый день — записал короткое видео. Вот, смотрите — похожая вывеска, которую мы делали: объёмные буквы, логотип.' }]).length, 1);
  assert.equal(findBannedPhrases([{ touchpoint_number: 3, body: 'Похожие буквы, которые мы сделали для кафе, — пришлю фото.' }]).length, 1);
  assert.equal(findBannedPhrases([{ touchpoint_number: 3, body: '[фото похожей работы — если есть] Вывеска как на первой точке.' }]).length, 0);
});
check('менеджеры удалённо: «заехал / был на производстве» ловится, «позвонил на производство» — нет', () => {
  assert.equal(findBannedPhrases([{ touchpoint_number: 1, body: 'Марина, был на производстве, видел похожую вывеску — вспомнил про вас.' }]).length, 1);
  assert.equal(findBannedPhrases([{ touchpoint_number: 1, body: 'Марина, заехал посмотреть вашу первую точку.' }]).length, 1);
  assert.equal(findBannedPhrases([{ touchpoint_number: 1, body: 'Марина, позвонил на производство по вашему проекту — есть вопрос по подсветке.' }]).length, 0);
});
check('ИИ-штампы из «Зерно 7» ловятся', () => {
  for (const t of ['Марина, хочу сказать кое-что важное — пока есть время.', 'Записал видео, буквально полминуты.', 'Просто перешлите, займёт секунду.', 'Скажите прямо. Я не обижусь.', 'Хочу спросить честно: есть ли шанс?']) {
    assert.equal(findBannedPhrases([{ touchpoint_number: 1, body: t }]).length, 1, t);
  }
  assert.equal(findBannedPhrases([{ touchpoint_number: 1, body: 'Марина, разбирался сейчас с похожей вывеской и вспомнил про ваше открытие.' }]).length, 0);
});

// Владелец 14.11: «рейтингов нет, но есть масса кейсов — заход через кейсы».
check('кейс из списка компании — можно; выдуманный кейс по названию — ловится; из переписки — можно', () => {
  assert.equal(findBannedPhrases([{ touchpoint_number: 5, body: 'Марина, делали вывеску для кафе «Капи» в ТЦ — пришлю фото.' }]).length, 0);
  assert.equal(findBannedPhrases([{ touchpoint_number: 5, body: 'Делали логотип с контражуром для Smoke Dog — очень похоже на ваш.' }]).length, 0);
  const bad = findBannedPhrases([{ touchpoint_number: 5, body: 'Марина, недели две назад делали вывеску для кофейни «Бариста» — похоже на ваш формат.' }]);
  assert.equal(bad.length, 1);
  assert.ok(/Бариста/.test(bad[0].fixes.join(' ')));
  assert.equal(findBannedPhrases([{ touchpoint_number: 5, body: 'Делали вывеску для «Зерна» на первой точке?' }], 'Кофейня «Зерно»: нужна как на первой точке — делали вывеску для «Зерна» не мы').length, 0);
});
check('каждое название из engine/cases.js есть в signage.md', () => {
  const md = require('fs').readFileSync(require('path').join(__dirname, '..', 'knowledge/industry/signage.md'), 'utf8');
  const { CASE_NAMES } = require('../engine/cases');
  const aliases = new Set(['Смоук Дог', 'Кауфман', 'Н-Дорс', 'Е ХАУС', 'Соколов']);
  for (const c of CASE_NAMES) if (!aliases.has(c)) assert.ok(md.includes(c), c);
});
check('бренд по продукту: металл — «Металл Буква Экспресс», иначе «Яркая Реклама»; не вывески — нет', () => {
  const { detectBrand } = require('../engine/brand');
  assert.equal(detectBrand({ industry: 'signage', product: 'Буквы из нержавеющей стали' }), 'Металл Буква Экспресс');
  assert.equal(detectBrand({ industry: 'signage', product: 'Световая вывеска (объёмные буквы с подсветкой)' }), 'Яркая Реклама');
  assert.equal(detectBrand({ industry: 'saas', product: 'CRM' }), null);
});

check('«Правило 7 касаний»: пустые напоминания ловятся, вопрос-температура — нет', () => {
  for (const t of ['Марина, ну как, решили?', 'Есть какие-то новости?', 'Хорошо, будем на связи!', 'Просто напоминаю о нашем КП.']) {
    assert.equal(findBannedPhrases([{ touchpoint_number: 1, body: t }]).length, 1, t);
  }
  assert.equal(findBannedPhrases([{ touchpoint_number: 1, body: 'Марина, к какому варианту склоняетесь — баннер сейчас или сразу постоянная?' }]).length, 0);
});

check('временная вывеска + «без доплат» в одном касании — на правку; «без доплат» без баннера — можно', () => {
  assert.equal(findBannedPhrases([{ touchpoint_number: 2, body: 'Временная вывеска к 1 декабря. Цена 185 000 ₽ — по КП, без доплат по ходу.' }]).length, 1);
  assert.equal(findBannedPhrases([{ touchpoint_number: 2, body: 'Цена 185 000 ₽ — по КП, без доплат по ходу.' }]).length, 0);
  assert.equal(findBannedPhrases([{ touchpoint_number: 2, body: 'Временная к открытию, постоянная — по КП, без доплат; по временной сориентирую отдельно.' }]).length, 0);
});

check('прогон 15.11 «Fresh Bowl»: контакт клиента-рекомендателя без упоминания в материалах — выдумка', () => {
  const { findBannedPhrases } = require('../engine/phraseCheck');
  const m = (body) => [{ touchpoint_number: 1, body }];
  const src = 'Ксения (04.11): В прошлый раз мы обожглись с подрядчиком.';
  assert.ok(findBannedPhrases(m('Сергей, могу дать контакт нашего клиента с похожей вывеской — он расскажет, как всё было.'), src).some((h) => /контакт нашего клиента/.test(h.fixes.join(' '))));
  assert.ok(findBannedPhrases(m('Есть клиент, который готов рассказать, как мы работаем.'), src).length);
  assert.equal(findBannedPhrases(m('Работаем по договору, выезд по гарантии — в течение 3 рабочих дней. Скинете контакт Сергея?'), src).length, 0);
  // Менеджер сам написал, что такой клиент есть — можно.
  assert.equal(findBannedPhrases(m('Могу дать контакт нашего клиента — владельца кафе, он готов рассказать.'), src + '\nРуководитель дал контакт клиента из «Мяты», готов дать рекомендацию.').length, 0);
});

check('живой прогон 15.11 «Fresh Bowl»: «ниже себестоимости», «по цене договоримся», безымянный кейс, «в будни» не в выходной', () => {
  const { findBannedPhrases } = require('../engine/phraseCheck');
  const one = (body, timing = '18 ноября (ср), утром') => findBannedPhrases([{ touchpoint_number: 1, body, timing }], '').flatMap((h) => h.fixes).join(' ');
  assert.match(one('Скидку 20% дать не могу — это ниже себестоимости качественного продукта.'), /себестоимост/);
  assert.match(one('Если да — по цене мы, уверена, договоримся.'), /приглашение к скидке/);
  assert.match(one('Делали вывеску для сети здорового питания — объёмные буквы, как у вас.'), /кейс без имени/);
  assert.match(one('Если удобнее обсудить в будни — скажите, перенесём.', '10 декабря (чт), утром'), /не на выходной/);
  assert.equal(one('Не отвлекаю в выходной? Если удобнее в будни — наберу в понедельник.', 'Сегодня, 15 ноября (вс) — выходной'), '');
  assert.equal(one('Работаем по договору, выезд по гарантии — в течение 3 рабочих дней.'), '');
});

console.log(`phraseCheck: ${passed} проверок пройдено`);
