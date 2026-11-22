// store 用了 localStorage（persist）：測試裡給一個空的
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
console.warn = () => {};
import { makeClip, useStore, type Media } from '../src/store';
import { beginHistoryTransaction, endHistoryTransaction, redo, resetHistory, settleHistory, undo } from '../src/engine/history';
import { useAutoEdit } from '../src/engine/autoEditSettings';
import { applyProposals } from '../src/ai/projectTools';
import { planItems, type MusicSource } from '../src/engine/autoEditApply';
import { fxLevel } from '../src/engine/tracks';
import type { EditPlan } from '../src/engine/autoEdit';

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

if (fails) {
  console.log(`\n${fails} 個失敗`);
  process.exit(1);
}
