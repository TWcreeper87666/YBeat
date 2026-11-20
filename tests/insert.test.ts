// store 用了 localStorage（persist）：測試裡給一個空的
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
console.warn = () => {};
import { displayRows, useStore } from '../src/store';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

const img = { id: 'img', name: 'p', kind: 'image', url: '', width: 100, height: 100, duration: 0, thumb: '', hasAudio: false };
const clipAt = (id: string, track: number, start: number, duration: number) => ({ id, mediaId: 'img', track, start, duration, in: 0, fit: 'cover', transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }, keys: {}, remap: { moduleId: 'remap-speed', params: {} }, transitionIn: null, transitionOut: null, volume: 1 });

for (const upperAt of ['bottom', 'top'] as const) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useStore.setState({ media: [img as any], clips: [clipAt('a', 0, 0, 5) as any, clipAt('b', 1, 8, 5) as any], audios: [], effects: [], tracks: { video: [{}, {}], fx: [], audio: [] }, upperAt, activeTrack: { kind: 'video', idx: 1 }, selection: null, selected: [], time: 3 });
  const s0 = useStore.getState();
  useStore.getState().insertMedia('img');
  let s = useStore.getState();
  const c = s.clips.find((x) => !['a', 'b'].includes(x.id))!;
  ok(!!c && c.start === 3 && c.track === 1 && s.tracks.video.length === 2, `${upperAt}：選中的軌道在播放頭有空位 → 放在播放頭、同一條軌道`);

  useStore.setState({ ...s0, clips: s0.clips, tracks: s0.tracks, activeTrack: { kind: 'video', idx: 1 }, time: 9 });
  const rowsBefore = displayRows(useStore.getState().tracks, upperAt);
  const selRow = rowsBefore.findIndex((r) => r.kind === 'video' && r.idx === 1);
  useStore.getState().insertMedia('img');
  s = useStore.getState();
  const n = s.clips.find((x) => !['a', 'b'].includes(x.id))!;
  const rows = displayRows(s.tracks, upperAt);
  const newRow = rows.findIndex((r) => r.kind === 'video' && r.idx === n.track);
  const bRow = rows.findIndex((r) => r.kind === 'video' && r.idx === s.clips.find((x) => x.id === 'b')!.track);
  ok(s.tracks.video.length === 3 && n.start === 9, `${upperAt}：被佔用 → 新增軌道、還是放在播放頭`);
  ok(bRow === selRow && newRow === bRow + 1, `${upperAt}：新軌道就在選中的軌道正下方`);
  ok(s.activeTrack?.kind === 'video' && s.activeTrack.idx === n.track && s.selection?.id === n.id, `${upperAt}：選中新的軌道與新片段`);
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
if (fails) process.exit(1);
