(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
console.warn = () => {};
import { clipSource } from '../src/engine/remap';
import { CURVE_ID, curveCode, curveToKeys, evalCurve, keysToCurve, parseCurve } from '../src/engine/remapCurve';
import { BUILTIN_MODULES } from '../src/modules/builtin';
import { remapFor, stretchPatch, useStore } from '../src/store';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const near = (a: number, b: number, e = 1e-3) => Math.abs(a - b) < e;

const media: any = { id: 'v', name: 'v', kind: 'video', url: '', width: 100, height: 100, duration: 20, thumb: '', hasAudio: false };
const clip = (p: any = {}): any => ({ id: 'c', mediaId: 'v', track: 0, start: 0, duration: 4, in: 2, fit: 'cover', transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }, keys: {}, remap: { moduleId: 'remap-speed', params: {} }, transitionIn: null, transitionOut: null, volume: 1, ...p });
const modules = new Map(BUILTIN_MODULES.map((m) => [m.id, m]));
ok(near(clipSource(clip({ remap: { moduleId: 'remap-none', params: {} } }), 2, media, modules).src, 4), '無：保持正常播放');
ok(near(clipSource(clip({ remap: { moduleId: 'remap-reverse', params: {} } }), 0, media, modules).src, 6)
  && near(clipSource(clip({ remap: { moduleId: 'remap-reverse', params: {} } }), 2, media, modules).src, 4), '倒播：從片段尾端往回播放');
const stretchedNone = stretchPatch('clip', clip({ remap: { moduleId: 'remap-none', params: {} } }), 0, 0.5) as any;
ok(stretchedNone.remap?.moduleId === 'remap-speed' && near(stretchedNone.remap.params.speed, 2), '無：拖曳縮短片段後切到 2× 變速');

// 正播後倒播（內建）套用 → 曲線模式
const pp = BUILTIN_MODULES.find((m) => m.id === 'remap-pingpong')!;
const r = remapFor(clip(), pp.id, BUILTIN_MODULES);
ok(r.moduleId === CURVE_ID && r.keys?.length === 3, '套用素材庫的曲線 → 曲線模式、展開成 3 個關鍵影格');
const c = clip({ remap: r });
ok(near(clipSource(c, 0, media, modules).src, 2), '開頭：素材時間 = in');
ok(near(clipSource(c, 2, media, modules).src, 4), '中間：正播到 in + 2 秒');
ok(near(clipSource(c, 4, media, modules).src, 2), '結尾：倒播回 in');
ok(clipSource(c, 1, media, modules).rate > 0 && clipSource(c, 3, media, modules).rate < 0, '前半速率為正（正播）、後半為負（倒播）');

// 切到「曲線」：從目前的速度開始
const fast = remapFor(clip({ remap: { moduleId: 'remap-speed', params: { speed: 2 } } }), CURVE_ID, BUILTIN_MODULES);
ok(fast.keys!.length === 2 && near(fast.keys![1].v, 8), '2× 切成曲線：結尾素材時間 = 長度 × 2');
const rev = remapFor(clip({ remap: { moduleId: 'remap-reverse', params: {} } }), CURVE_ID, BUILTIN_MODULES);
ok(near(rev.keys![0].v, 4) && near(rev.keys![1].v, 0), '倒放切成曲線：從尾巴倒回開頭');
ok(remapFor(c, CURVE_ID, BUILTIN_MODULES) === c.remap, '本來就是曲線：保留原本的曲線');
ok(remapFor(c, 'remap-strobe', BUILTIN_MODULES).keys === undefined, '換成其他模式：曲線拿掉');

// 存到素材庫再套用（片段長度不同 → 按比例展開）
const code = curveCode(keysToCurve(c.remap.keys, c.duration));
const parsed = parseCurve(code)!;
ok(!!parsed && parsed.length === 3, '存成程式碼後讀得回曲線');
const k8 = curveToKeys(parsed, 8);
ok(near(k8[1].t, 4) && near(k8[1].v, 4), '套用到 8 秒的片段：轉折點在 4 秒、素材時間 4 秒');
const fn = new Function('ease', `"use strict";\n${code}\n;return remap;`)({ curve: evalCurve });
ok(near(fn(2, {}, { dur: 4 }), 2) && near(fn(4, {}, { dur: 4 }), 0), '存的模組程式碼本身也能跑（縮圖用）');

// 拉長（Ctrl+拖曳）：曲線時間跟著伸縮
const st = stretchPatch('clip', c, 0, 2) as any;
ok(near(st.remap.keys[1].t, 4) && near(st.remap.keys[2].t, 8) && near(st.remap.keys[1].v, 2), '片段拉長 2 倍：曲線時間 ×2、素材時間不變');

// 分割：後段的素材時間要接得上
useStore.setState({ media: [media], clips: [c], audios: [], effects: [], modules: BUILTIN_MODULES, tracks: { video: [{}], fx: [], audio: [] }, selection: { type: 'clip', id: 'c' }, selected: ['clip:c'], time: 3 } as any);
useStore.getState().split();
const s = useStore.getState();
if (s.clips.length === 2) {
  const [a, b] = [...s.clips].sort((x, y) => x.start - y.start);
  const m2 = new Map(s.modules.map((m) => [m.id, m]));
  ok(near(clipSource(a, 2, media, m2).src, 4), '分割後前段不變');
  ok(near(clipSource(b, 0, media, m2).src, clipSource(c, 3, media, modules).src, 0.02) && near(clipSource(b, 1, media, m2).src, 2, 0.02), '分割後後段接得上、一樣倒播回 in');
} else ok(false, '分割：找不到 splitAt 或沒切開');

// 內建的曲線預設都讀得出來、程式碼本身也能跑
for (const m of BUILTIN_MODULES.filter((x) => x.kind === 'remap' && parseCurve(x.code))) {
  const f = new Function('ease', `"use strict";
${m.code}
;return remap;`)({ curve: evalCurve });
  ok(Number.isFinite(f(0.5, {}, { dur: 1 })), `內建曲線「${m.name}」可以解析、可以執行`);
}

// 素材不夠長：曲線整條等比例壓低（不會跑到素材結尾後定格）
const ramp = BUILTIN_MODULES.find((m) => m.id === 'remap-ramp')!;
const r1 = remapFor(clip({ duration: 4 }), ramp.id, BUILTIN_MODULES, 5);
ok(Math.max(...r1.keys!.map((k) => k.v)) <= 5 + 1e-9, '速度斜坡套在只剩 5 秒素材的片段：素材時間不超過 5 秒');
const r2 = remapFor(clip({ duration: 4 }), ramp.id, BUILTIN_MODULES, 100);
ok(near(Math.max(...r2.keys!.map((k) => k.v)), 1.92 * 4), '素材夠長：照原本的曲線');

console.log(fails ? `\n${fails} 個失敗` : '\n全部通過');
if (fails) process.exit(1);
