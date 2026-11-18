'use strict';
const assert = require('assert');
const { priceGuide, parseParams } = require('../engine/priceGuide');
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

check('живой тест 18.11 «Гибкость»: 3 м световых букв + табличка + монтаж — вилка −20% / +40% от себестоимости × 1,8', () => {
  const g = priceGuide({ product: 'Световые объёмные буквы из акрила + табличка у входа', industry: 'signage' },
    'Нужна световая вывеска на студию, длина примерно 3 метра + табличка у входа. Сколько стоит?');
  assert.equal(g.coef, 1.8);
  assert.ok(g.x > 50000 && g.x < 80000, String(g.x));
  assert.ok(g.client_range.from <= g.x * 0.8 && g.client_range.from % 5000 === 0, String(g.client_range.from));
  assert.ok(g.client_range.to >= g.x * 1.4 && g.client_range.to % 5000 === 0, String(g.client_range.to));
  assert.ok(g.torg_floor < g.x);
});
check('металл — коэффициент 2; высота и текст — без допущения о длине', () => {
  const g = priceGuide({ product: 'Объёмные буквы из латуни', industry: 'signage' }, 'Текст «BROT & BUTTER», высота букв 30 см');
  assert.equal(g.coef, 2);
  assert.ok(!g.assumptions.some((a) => /по длине/.test(a)));
});
check('нет размеров / продукт не распознан / не вывески — null (вилку не выдумываем)', () => {
  assert.equal(priceGuide({ product: 'Вывеска', industry: 'signage' }, 'Сколько стоит?'), null);
  assert.equal(priceGuide({ product: 'Срубы', industry: 'construction' }, 'длина 6 метров'), null);
});
check('«без монтажа» — монтаж не считаем; разбор длины в см и метрах', () => {
  const src = 'световые буквы, длина 4 метра';
  const a = priceGuide({ product: 'Световые буквы', industry: 'signage' }, src);
  const b = priceGuide({ product: 'Световые буквы', industry: 'signage' }, src + ', без монтажа — сами повесим');
  assert.ok(b.x < a.x);
  assert.equal(parseParams('длина 250 см').lengthCm, 250);
});
console.log(`priceGuide: ${n} проверок пройдено`);
