import { trialTransitionAt } from '../src/engine/trialTransition';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clip = (id: string, track: number, start: number, duration: number): any => ({ id, mediaId: 'm', track, start, duration, transitionIn: null, transitionOut: null });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod: any = { id: 'tr-fade', kind: 'transition', code: '' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctxOf = (tracks: any[][], hidden: boolean[] = []): any => ({
  clips: tracks.flat(),
  videoTracks: tracks,
  tracks: { video: tracks.map((_, i) => ({ hidden: hidden[i] })), fx: [], audio: [] },
  modules: new Map(),
  media: new Map(),
  effects: [],
  audios: [],
  linked: new Set(),
});

const a = clip('a', 0, 0, 4), b = clip('b', 0, 4, 3);
let r = trialTransitionAt(ctxOf([[a, b]]), 4, mod, 0.8, 0.1);
ok(!!r && r.cut === 4 && r.d === 0.8, '播放頭在剪接點 → 找到這個剪接點');
ok(!!r && r.ctx.videoTracks[0][1].transitionIn?.moduleId === 'tr-fade' && b.transitionIn === null, '轉場只暫時套在複製的後一段，原片段不變');
ok(!!r && r.ctx.clips.find((c: { id: string }) => c.id === 'b')?.transitionIn?.moduleId === 'tr-fade', 'ctx.clips 也換成套了轉場的片段');
ok(!!r && Math.abs(r.lo - 3.1) < 1e-9 && Math.abs(r.hi - 4.9) < 1e-9, '循環範圍 = 轉場前後各多 0.5 秒');
ok(trialTransitionAt(ctxOf([[a, b]]), 3.5, mod, 0.8, 0.1) === null, '播放頭不在剪接點 → 沒有');
ok(trialTransitionAt(ctxOf([[a, clip('c', 0, 5, 3)]]), 5, mod, 0.8, 0.1) === null, '兩段中間有空隙 → 不算剪接點');

const short = clip('s', 0, 4, 0.3);
r = trialTransitionAt(ctxOf([[a, short]]), 4, mod, 0.8, 0.1);
ok(!!r && Math.abs(r.d - 0.3) < 1e-9 && r.hi <= 4.3, '片段比轉場短：轉場長度與循環範圍都不超過片段');

const top = [clip('t1', 1, 0, 4), clip('t2', 1, 4, 4)];
r = trialTransitionAt(ctxOf([[a, b], top]), 4, mod, 0.8, 0.1);
ok(!!r && r.track === 1, '多條軌道都有剪接點 → 先用上面的軌道');
r = trialTransitionAt(ctxOf([[a, b], top]), 4, mod, 0.8, 0.1, 0);
ok(!!r && r.track === 0, '有選中的軌道 → 先用選中的');
r = trialTransitionAt(ctxOf([[a, b], top], [false, true]), 4, mod, 0.8, 0.1);
ok(!!r && r.track === 0, '隱藏的軌道略過');

console.log(fails ? `\n${fails} 個失敗` : '\n全部通過');
if (fails) process.exit(1);
