import { strict as assert } from 'node:assert';
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
import { Need, clipStill } from '../src/engine/jobNeed';
import { makeClip, useStore } from '../src/store';

// ── 有人需要就繼續 ──
{
  let a = true, b = false;
  const n = new Need();
  n.add('a', () => a);
  n.add('b', () => b);
  assert.equal(n.live(), true);
  a = false;
  assert.equal(n.live(), false, '全部都不需要 → 停');
  n.add('a', () => true);
  assert.equal(n.live(), true, '同一個 id 換成最新的檢查');
  const always = new Need();
  always.add();
  assert.equal(always.live(), true, '匯出 / 重試：一定要算完');
}
console.log('PASS Need');

// ── 片段還需要嗎 ──
{
  const c = { ...makeClip({ mediaId: 'm', duration: 4 }), id: 'c1', aiMatte: true };
  useStore.setState({ clips: [c] as any });
  const still = clipStill(c, (x) => !!x.aiMatte);
  assert.equal(still(), true);
  useStore.setState({ clips: [{ ...c, aiMatte: undefined }] as any });
  assert.equal(still(), false, '關掉功能');
  useStore.setState({ clips: [{ ...c, duration: 2 }] as any });
  assert.equal(still(), false, '修剪（範圍變了，舊的工作不用算完）');
  useStore.setState({ clips: [] });
  assert.equal(still(), false, '刪除');
  useStore.setState({ clips: [c] as any });
  assert.equal(still(), true, '復原 → 又需要了');
}
console.log('PASS 片段還需要嗎');
