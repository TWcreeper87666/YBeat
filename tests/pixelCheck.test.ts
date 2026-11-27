import { strict as assert } from 'node:assert';
import { renderProblem, renderPrompt } from '../src/ai/pixelCheck';

const N = 16;
const fill = (r: number, g: number, b: number, a = 255) => {
  const p = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) p.set([r, g, b, a], i * 4);
  return p;
};
const base = fill(200, 80, 120);
const other = fill(40, 200, 190);

assert.equal(renderProblem('effect', base, [fill(0, 0, 0), fill(1, 2, 0), fill(0, 0, 3)]), 'black');
console.log('PASS 整片黑');
assert.equal(renderProblem('effect', fill(1, 1, 1), [fill(0, 0, 0), fill(1, 1, 1)]), 'unchanged');
console.log('PASS 原圖本來就暗：不判黑（但沒變化照樣抓）');
assert.equal(renderProblem('effect', base, [fill(0, 0, 0, 0), fill(200, 80, 120, 3)]), 'transparent');
console.log('PASS 全透明');
assert.equal(renderProblem('effect', base, [fill(200, 80, 120), fill(201, 80, 119)]), 'unchanged');
console.log('PASS 跟原圖一樣');
assert.equal(renderProblem('effect', base, [fill(200, 80, 120), fill(100, 40, 60), fill(200, 80, 120)]), null);
console.log('PASS 有一格不一樣就算有做事');
assert.equal(renderProblem('effect', base, [fill(0, 0, 0), fill(100, 40, 60)]), null);
console.log('PASS 只有一格黑不算');
assert.equal(renderProblem('transition', base, [other, other, other], other), 'unchanged');
console.log('PASS 轉場一直是後一段 = 沒做事');
assert.equal(renderProblem('transition', base, [base, fill(120, 140, 155), other], other), null);
console.log('PASS 正常轉場');
assert.equal(renderProblem('effect', base, []), null);
console.log('PASS 沒有畫面不判');
assert.ok(renderPrompt('effect', 'black', [0.05, 0.5], 'LOOKS_OK').includes('black') &&
  renderPrompt('effect', 'unchanged', [0.5], 'LOOKS_OK').includes('LOOKS_OK'));
console.log('PASS 丟回去的訊息');
