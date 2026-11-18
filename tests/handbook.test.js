'use strict';
const assert = require('assert');
const { handbookPages } = require('../engine/handbook');
const { SCENARIO_WHY } = require('../engine/mentor');
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
check('справочник: страницы с заголовком «## », у каждой есть ссылка-алиас', () => {
  const pages = handbookPages();
  assert.ok(pages.length >= 13);
  for (const p of pages) { assert.ok(/^## /.test(p.text), p.id); assert.ok(p.aliases.length, p.id); }
});
check('наставник ссылается только на страницы, которые есть в справочнике', () => {
  const aliases = new Set(handbookPages().flatMap((p) => p.aliases));
  const src = require('fs').readFileSync(require.resolve('../engine/mentor'), 'utf8');
  const refs = [...src.matchAll(/\(([А-ЯЁA-Z][^()']{1,40})\)'/g)].flatMap((m) => m[1].split(/,\s*/));
  refs.push('Формула закрытия');
  for (const r of refs) assert.ok(aliases.has(r), `нет страницы для «${r}»`);
  assert.ok(Object.keys(SCENARIO_WHY).length >= 6);
});
console.log(`handbook: ${n} проверок пройдено`);
