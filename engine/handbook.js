'use strict';
/**
 * Справочник для менеджеров (владелец 18.11): методики владельца — по странице на методику, в разметке чата
 * (## / ### / - / **жирный** / _подсказка_). Источник — handbook/*.md (сжатая выжимка из knowledge/).
 * aliases — как на страницу ссылается «Наставник» в скобках: «(Возражения)», «(Zoom)».
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'handbook');
const ALIASES = {
  '01_formula': ['Формула закрытия'],
  '02_soprano': ['СОПРАНО'],
  '03_seven_touches': ['Правило 7 касаний'],
  '04_triggers': ['Триггеры'],
  '05_presentation': ['Презентация'],
  '06_offer': ['Оффер'],
  '07_objections': ['Возражения'],
  '08_negative': ['Негативная фаза'],
  '09_perepiska': ['Переписка'],
  '10_zoom': ['Zoom'],
  '11_lpr': ['ЛДПР', 'ЛПР'],
  '12_price': ['Цена'],
  '13_last_chance': ['Последний шанс']
};

let cache = null;
function handbookPages() {
  if (cache) return cache;
  cache = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const id = f.replace(/\.md$/, '');
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    const title = (text.match(/^##\s+(.+)$/m) || [null, id])[1].trim();
    return { id, title, aliases: ALIASES[id] || [], text };
  });
  return cache;
}

module.exports = { handbookPages, ALIASES };
