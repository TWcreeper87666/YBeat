// store 用了 localStorage（persist）：測試裡給一個空的
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
console.warn = () => {};
import { makeClip, useStore, type Media } from '../src/store';
import { beginHistoryTransaction, endHistoryTransaction, redo, resetHistory, settleHistory, undo } from '../src/engine/history';
import { aeFootage, useAutoEdit } from '../src/engine/autoEditSettings';
import { applyProposals } from '../src/ai/projectTools';
import { facePush, planItems, type MusicSource } from '../src/engine/autoEditApply';
import { mediaToFrame } from '../src/engine/follow';
import { fxLevel } from '../src/engine/tracks';
import type { EditPlan } from '../src/engine/autoEdit';
import { speedCurve } from '../src/engine/speedRamp';
import { clipSource } from '../src/engine/remap';
import { makeCtx } from '../src/engine/renderer';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const S = () => useStore.getState();

const media: Media[] = [
  { id: 'v', name: 'v.mp4', kind: 'video', url: '', width: 1080, height: 1920, duration: 3, thumb: '', hasAudio: true },
  { id: 'i', name: 'i.jpg', kind: 'image', url: '', width: 1080, height: 1920, duration: 0, thumb: '', hasAudio: false },
];
const reset = (clips = 0) => {
  useStore.setState({
    media, clips: clips ? [makeClip({ mediaId: 'v', start: 0, duration: 1 })] : [], audios: [], effects: [],
    tracks: { video: [{}], fx: [{}], audio: [{}] }, selection: null, selected: [],
  });
  resetHistory();
};

// 每拍 0.5 秒，16 拍；第 0 拍 = 片段開頭、第 16 拍 = 片段結尾
const src = { beats: Array.from({ length: 16 }, (_, i) => ({ t: i * 0.5, s: 1, down: i % 4 === 0 })), time: (i: number) => Math.min(8, Math.max(0, i) * 0.5) } as unknown as MusicSource;
const plan: EditPlan = {
  seed: 1, recipe: 'rhythm',
  shots: [
    { b0: 0, b1: 4, mediaId: 'i', in: 0, motion: { from: { scale: 1, x: 0, y: 0 }, to: { scale: 1.12, x: 0.02, y: 0 } } },
    { b0: 4, b1: 8, mediaId: 'v', in: 2, transition: { moduleId: 'tr-whip', beats: 0.5 } },
    { b0: 8, b1: 16, mediaId: 'i', in: 0, transition: { moduleId: 'tr-crossfade', beats: 1 } },
  ],
  overlays: [
    { b0: 8, b1: 9, moduleId: 'fx-flash' },
    { b0: 10, b1: 14, moduleId: 'fx-zoompulse', everyBeat: true },
    { b0: 14, b1: 15, moduleId: 'fx-nope' },
  ],
};

reset();
const { clips, effects } = planItems(plan, src, S());
ok(clips.length === 3 && clips[0].start === 0 && clips[2].start + clips[2].duration === 8, '鏡頭換成秒數，接滿整段');
ok(clips[1].in === 1 && clips[1].volume === 0, '影片 in 不超出素材長度（3 秒素材、2 秒鏡頭 → in 1）、原音靜音');
ok(!!clips[0].keys.scaleX && clips[0].keys.scaleX![1].v === 1.12 && clips[0].keys.scaleX![1].t === 2, '圖片有推近的關鍵影格');
ok(!clips[0].transitionIn && clips[1].transitionIn?.moduleId === 'tr-whip' && Math.abs(clips[1].transitionIn.duration - 0.25) < 1e-9, '轉場長度 = 拍數 × 拍長');
ok(effects.length === 2, '不存在的模組略過');
ok(effects[1].trigger?.kind === 'beat' && effects[1].duration === 2, '每拍觸發的點綴');
ok(effects[0].duration <= 0.5, '衝擊特效只打一下（不超過一拍）');

// 空的時間軸：直接用唯一的影片軌，特效放在影片軌上方
applyProposals([{ summary: '', op: { op: 'add_items', clips, effects } }]);
ok(S().tracks.video.length === 1 && S().clips.length === 3 && S().clips.every((c) => c.track === 0), '空時間軸 → 用原本的影片軌');
const ft = S().effects[0].track;
ok(S().effects.every((e) => e.track === ft) && fxLevel(S().tracks, ft) >= S().tracks.video.length, '點綴在影片軌上方的特效軌');
undo();
ok(S().clips.length === 0 && S().effects.length === 0, '一步復原');

// 已經有片段：新增一條最上層的影片軌
reset(1);
applyProposals([{ summary: '', op: { op: 'add_items', clips, effects } }]);
ok(S().tracks.video.length === 2 && S().clips.filter((c) => c.track === 1).length === 3 && S().clips.filter((c) => c.track === 0).length === 1, '有內容 → 新增最上層影片軌，不動原本的片段');
ok(S().effects.every((e) => fxLevel(S().tracks, e.track) >= 2), '特效軌在新影片軌上方');

// 主體跳出：計畫 → 片段
reset();
const popPlan: EditPlan = {
  seed: 1, recipe: 'rhythm',
  shots: [
    { b0: 0, b1: 8, mediaId: 'v', in: 0 },
    { b0: 8, b1: 16, mediaId: 'i', in: 0, transition: { moduleId: 'tr-whip', beats: 0.5 }, motion: { from: { scale: 1.12, x: 0.03, y: -0.02 }, to: { scale: 1, x: 0, y: 0 } } },
  ],
  overlays: [],
  pops: [{ b0: 4, b1: 8, variant: 'shake', mediaId: 'i', cx: 0.2, cy: -0.1 }],
};
const pp = planItems(popPlan, src, S());
const layer = pp.clips.find((c) => c.track === 1)!;
const revealClip = pp.clips.find((c) => c.track === 0 && c.start === 4)!;
ok(!!layer && layer.aiMatte === true && layer.start === 2 && layer.start + layer.duration === 4 && layer.volume === 0, '主體層：去背、在揭露拍前 4 拍、剛好結束在揭露拍');
ok(layer.keys.scaleX!.map((k) => k.v).join() === '0.55,0.7,0.85,1,1' && layer.keys.scaleX![0].ease === 'hold', '每拍放大一級（停住型關鍵影格），最後 = 1');
ok(Math.abs(layer.keys.x![0].v - 0.09) < 1e-9 && layer.keys.x!.at(-1)!.v === 0, '縮放時位移補償，主體留在原位；最後位移 0 跟完整圖對齊');
ok(layer.effects?.length === 2 && layer.effects.every((f) => f.timing?.kind === 'beat'), '震閃：兩個每拍觸發的片段特效');
ok(!revealClip.transitionIn && revealClip.keys.scaleX![0].v === 1 && revealClip.keys.x![0].v === 0, '揭露拍：硬切、完整圖從原尺寸開始（拉遠改成推近）');

// 主體跳出（影片的一格）：主體層停在那一格、揭露拍從那一格接著播
{
  reset();
  const v = S().media.find((m) => m.id === 'v')!;
  const frame = { ...v, id: 'v@3.00', srcId: 'v', from: 3, duration: v.duration - 3 };
  const plan: EditPlan = {
    seed: 1, recipe: 'rhythm',
    shots: [{ b0: 0, b1: 8, mediaId: 'v', in: 0 }, { b0: 8, b1: 12, mediaId: 'v@3.00', in: 0 }],
    overlays: [], pops: [{ b0: 4, b1: 8, variant: 'step', mediaId: 'v@3.00', cx: 0, cy: 0 }],
  };
  const r = planItems(plan, src, S(), [v, frame]);
  const sub = r.clips.find((c) => c.track === 1)!;
  const rev = r.clips.find((c) => c.track === 0 && c.start === 4)!;
  ok(!!sub && sub.mediaId === 'v' && sub.in === 3 && sub.aiMatte === true, '主體層：原影片、從那一格開始、去背');
  ok(sub.remap?.moduleId === 'remap-curve' && sub.remap.keys.every((k) => k.v === 0), '主體層：停在那一格');
  ok(!!rev && rev.mediaId === 'v' && rev.in === 3 && rev.remap?.moduleId !== 'remap-curve', '揭露拍：同一支影片從那一格接著播（正常速度）');
}

// 暗角：中間亮的範圍跟著音樂音量（越大聲越小），只聽音樂那一軌
{
  reset();
  const plan: EditPlan = { seed: 1, recipe: 'rhythm', shots: [{ b0: 0, b1: 8, mediaId: 'v', in: 0 }], overlays: [{ b0: 0, b1: 8, moduleId: 'fx-vignette', lane: 0 }], pops: [] };
  const vig = planItems(plan, src, S()).effects.find((e) => e.moduleId === 'fx-vignette');
  const d = vig?.audio?.size;
  ok(!!d && d.source === 'level' && d.min > d.max && (src.audio ? JSON.stringify(d.from) === JSON.stringify({ audio: [src.audio.track] }) : !d.from), '暗角跟著音樂音量收放');
}

// 跟拍變速：計畫 → 變速曲線片段
reset();
const T2 = (i: number) => Math.min(8, Math.max(0, i) * 0.5);
const pulse = speedCurve('beatPulse', 0, 4, T2, 0.5)!;
const hold = speedCurve('holdHit', 4, 8, T2, 1, { hitBeat: 5 })!;
const spPlan: EditPlan = {
  seed: 1, recipe: 'rhythm', overlays: [], pops: [],
  shots: [
    { b0: 0, b1: 4, mediaId: 'v', in: 0.5, speed: pulse },
    { b0: 4, b1: 8, mediaId: 'v', in: 0.2, speed: hold },
    { b0: 8, b1: 12, mediaId: 'v', in: 2.5, speed: speedCurve('beatPulse', 8, 12, T2, 0.5)! },
  ],
};
const sc = planItems(spPlan, src, S()).clips;
const mods = makeCtx(S()).modules;
const srcAt = (c: typeof sc[number], t: number) => clipSource(c, t, media[0], mods).src;
ok(sc[0].remap.moduleId === 'remap-curve' && sc[0].in === 0.5 && Math.abs(srcAt(sc[0], 2) - (0.5 + pulse.sourceMax)) < 1e-3, '每拍快慢：變速曲線、in 照計畫、結尾用掉的素材 = 曲線長度');
const mid = srcAt(sc[0], 0.25), quarter = srcAt(sc[0], 0.05) - srcAt(sc[0], 0);
ok(mid > 0.5 && quarter / 0.05 > (srcAt(sc[0], 0.3) - srcAt(sc[0], 0.2)) / 0.1, '拍點附近比拍與拍之間快');
const h0 = srcAt(sc[1], 0.5 + 0.01), h1 = srcAt(sc[1], 0.5 + 0.2);
ok(Math.abs(h0 - h1) < 1e-6 && srcAt(sc[1], 1.5) > h1, '重音定格：停住後再接著播');
ok(sc[2].remap.moduleId === 'remap-speed', '素材不夠長（3 秒素材從 2.5 秒開始）→ 改回常速');

// 多層：track = 第幾層 → 每層一條新的影片軌，疊在最上面
reset(1);
const base = makeClip({ mediaId: 'i', start: 0, duration: 2, track: 0 });
const top1 = makeClip({ mediaId: 'i', start: 0, duration: 1, track: 1, aiMatte: true });
const top2 = makeClip({ mediaId: 'i', start: 0, duration: 1, track: 2 });
applyProposals([{ summary: '', op: { op: 'add_items', clips: [base, top1, top2], effects: [] } }]);
const tr = (id: string) => S().clips.find((c) => c.id === id)?.track;
ok(S().tracks.video.length === 4 && tr(base.id) === 1 && tr(top1.id) === 2 && tr(top2.id) === 3, `三層 → 三條新軌（原本的在最下面）：${[tr(base.id), tr(top1.id), tr(top2.id)]}`);
reset();
applyProposals([{ summary: '', op: { op: 'add_items', clips: [base, top1], effects: [] } }]);
ok(S().tracks.video.length === 2 && tr(base.id) === 0 && tr(top1.id) === 1, '空時間軸：基本層用原本的軌，上面加一條');
{
  reset();
  const txt = makeClip({ mediaId: '', start: 0, duration: 1, track: 1, text: { text: 'BEAT' } as any });
  applyProposals([{ summary: '', op: { op: 'add_items', clips: [makeClip({ mediaId: 'i', start: 0, duration: 1 }), txt], effects: [] } }]);
  ok(S().clips.some((c) => c.text?.text === 'BEAT' && c.track === 1), '文字片段（沒有素材）也會放上去');
}

// 面板設定也能復原（能量曲線、數字），而且跟時間軸在同一條紀錄裡
reset();
useAutoEdit.getState().reset();
resetHistory();
const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 0 }];
useAutoEdit.getState().set({ shape: { gain: 0, contrast: 1, points: pts } });
settleHistory();
useAutoEdit.getState().set({ recipe: 'hype' });
settleHistory();
undo();
ok(useAutoEdit.getState().recipe === 'rhythm' && useAutoEdit.getState().shape.points.length === 3, '復原一步 = 只退回最後的設定變更');
undo();
ok(useAutoEdit.getState().shape.points.length === 2, '再復原 = 曲線的點拿掉');
redo();
ok(useAutoEdit.getState().shape.points[1]?.y === 0.7, '重做把點放回來');
useAutoEdit.getState().set({ analysis: null });
settleHistory();
undo();
ok(useAutoEdit.getState().shape.points.length === 2, '分析結果不算一步（復原的是曲線）');

// 巢狀交易 = 一步
reset();
beginHistoryTransaction();
beginHistoryTransaction();
applyProposals([{ summary: '', op: { op: 'add_items', clips, effects: [] } }]);
endHistoryTransaction(true);
useAutoEdit.getState().set({ kenBurns: false });
endHistoryTransaction(true);
ok(S().clips.length === 3, '巢狀交易裡的變更有套上');
undo();
ok(S().clips.length === 0 && useAutoEdit.getState().kenBurns, '巢狀交易一步復原（含面板設定）');

// 指定片段：虛擬素材（長度 = 片段長度），放上時間軸換回原素材、入點加上片段起點
{
  reset();
  const long: Media = { ...media[0], id: 'L', duration: 60 };
  useStore.setState({ media: [...media, long] });
  const st = { ...useAutoEdit.getState(), pick: 'list' as const, segs: [{ id: 's1', mediaId: 'L', a: 10, b: 13 }, { id: 's2', mediaId: 'L', a: 40, b: 50 }, { id: 's3', mediaId: 'i', a: 0, b: 0 }, { id: 's4', mediaId: 'gone', a: 0, b: 1 }] };
  const feet = aeFootage(S(), st);
  ok(feet.length === 3 && feet[0].id === 'L@s1' && feet[0].duration === 3 && feet[0].from === 10 && feet[0].srcId === 'L' && feet[2].id === 'i', '片段 → 虛擬素材；圖片用原素材；不存在的素材略過');
  ok(aeFootage(S(), { ...st, pick: 'all', segs: [] }).length === 3, '全部素材 → 素材庫全部');
  ok(aeFootage(S(), { ...st, segs: [] }).length === 0, '自選清單清空 → 沒有素材');
  const segPlan: EditPlan = { seed: 1, recipe: 'rhythm', overlays: [], shots: [
    { b0: 0, b1: 4, mediaId: 'L@s1', in: 2 },
    { b0: 4, b1: 8, mediaId: 'L@s2', in: 1 },
  ] };
  const r = planItems(segPlan, src, S(), feet);
  ok(r.clips[0].mediaId === 'L' && r.clips[0].in === 11, '入點 = 片段起點 + 片段內的入點（不超出片段：3 秒片段、2 秒鏡頭 → 1）');
  ok(r.clips[1].mediaId === 'L' && r.clips[1].in === 41, '同一支影片的另一段');
}

// 推近到臉：臉往畫面中間移、放大、不露黑邊
{
  const m = { width: 1920, height: 1080 };
  const aspect = 16 / 9;
  const clip = makeClip({ mediaId: 'x', start: 0, duration: 2 });
  clip.keys = facePush({ x: 0.5, y: 0.4, h: 0.15 }, m, aspect, 2);
  const [fx, fy] = mediaToFrame(clip, m, 2, aspect, 0.5, 0.4);
  ok(Math.abs(fx - 0.5) < 1e-6 && Math.abs(fy - 0.5) < 1e-6, `臉到畫面中間（${fx.toFixed(3)}, ${fy.toFixed(3)}）`);
  const k = clip.keys!.scaleX!;
  ok(k[0].v < k[1].v && k[1].v <= 1.45 && k[1].v >= 1.12, '從寬推近，縮放 1.12..1.45');
  clip.keys = facePush({ x: 0.02, y: 0.02, h: 0.1 }, m, aspect, 2);
  const s1 = clip.keys!.scaleX![1].v;
  const [l, t] = mediaToFrame(clip, m, 2, aspect, 0, 0);
  ok(l <= 1e-6 && t <= 1e-6 && s1 > 1, '臉在角落：不露黑邊');
}

if (fails) {
  console.log(`\n${fails} 個失敗`);
  process.exit(1);
}
