import assert from 'node:assert/strict';
import { wrapText } from '../src/engine/textWrap';

// 量寬度：中文 / 全形 = 2，其他 = 1
const measure = (s: string) => [...s].reduce((n, c) => n + (/[　-鿿＀-￯]/.test(c) ? 2 : 1), 0);
const check = (name: string, fn: () => void) => { fn(); console.log(`PASS  ${name}`); };

check('沒超過寬度不換行', () => {
  assert.deepEqual(wrapText('今天天氣很好', 40, measure), ['今天天氣很好']);
});

check('原本的換行保留', () => {
  assert.deepEqual(wrapText('第一行\n第二行', 40, measure), ['第一行', '第二行']);
});

check('每行都不超過寬度、內容不少字', () => {
  const text = '今天我們在瀏覽器裡測試自動字幕，這個軟體可以幫你剪輯影片，還會自動對齊音樂的節拍。';
  const lines = wrapText(text, 30, measure);
  assert.ok(lines.length >= 2);
  for (const l of lines) assert.ok(measure(l) <= 30, l);
  assert.equal(lines.join(''), text);
});

check('優先斷在逗號後面', () => {
  const lines = wrapText('這個軟體可以幫你剪輯影片，還會自動對齊音樂的節拍', 30, measure);
  assert.ok(lines[0].endsWith('，'), JSON.stringify(lines));
});

check('行首不放標點', () => {
  for (const w of [10, 12, 14, 16, 18, 20]) {
    for (const l of wrapText('一二三四五，六七八九十。甲乙丙丁戊！己庚辛壬癸？', w, measure)) assert.ok(!/^[，。！？]/.test(l), `${w}: ${l}`);
  }
});

check('行數用最少、長度平均（不會剩一兩個字）', () => {
  const lines = wrapText('一二三四五六七八九十一二三四五六七八九十一二', 40, measure);
  assert.equal(lines.length, 2);
  assert.ok(Math.abs(measure(lines[0]) - measure(lines[1])) <= 4, JSON.stringify(lines));
});

check('英文只在空白處斷', () => {
  const lines = wrapText('The quick brown fox jumps over the lazy dog', 20, measure);
  for (const l of lines) assert.ok(measure(l) <= 20 && !l.startsWith(' ') && !l.endsWith(' '), l);
  assert.equal(lines.join(' '), 'The quick brown fox jumps over the lazy dog');
});

check('單字比整行還寬才硬切', () => {
  const lines = wrapText('supercalifragilisticexpialidocious', 10, measure);
  for (const l of lines) assert.ok(measure(l) <= 10, l);
  assert.equal(lines.join(''), 'supercalifragilisticexpialidocious');
});

console.log('\n全部通過');
