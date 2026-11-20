// store 用了 localStorage（persist）：測試裡給一個空的
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
const warn = console.warn;
console.warn = () => {};
import { useStore } from '../src/store';
import { resetHistory, undo } from '../src/engine/history';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const media = [{ id: 'm1', name: 'v', kind: 'video', url: '', width: 1080, height: 1920, duration: 10, thumb: '', hasAudio: true }];
const clip = { id: 'c1', mediaId: 'm1', track: 0, start: 0, duration: 4, in: 0, fit: 'cover', transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }, keys: {}, remap: { moduleId: 'remap-speed', params: {} }, transitionIn: null, transitionOut: null, volume: 1, link: 'L1' };
const au = { id: 'a1', mediaId: 'm1', track: 0, start: 0, duration: 4, in: 0, volume: 1, fadeIn: 0, fadeOut: 0, rate: 1, link: 'L1' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
useStore.setState({ media: media as any, clips: [clip as any], audios: [au as any], effects: [], selected: ['clip:c1', 'audio:a1'], selection: { type: 'clip', id: 'c1' } });

ok(useStore.getState().splitAtTimes([3, 1, 2, 9]) === 6, '影片 + 原音各切 3 刀（範圍外的時間不算）');
const s = useStore.getState();
const check = (list: { start: number; duration: number; in: number }[], name: string) => {
  const l = [...list].sort((a, b) => a.start - b.start);
  ok(l.length === 4, `${name}：切成 4 段`);
  ok(l.every((x, i) => near(x.start, i) && near(x.duration, 1) && near(x.in, i)), `${name}：每段 1 秒、不重疊、素材位置接得上`);
};
check(s.clips, '影片');
check(s.audios, '原音');
const pairs = s.clips.every((c) => s.audios.some((a) => a.link === c.link && near(a.start, c.start)));
ok(pairs && new Set(s.clips.map((c) => c.link)).size === 4, '每段影片跟同時間的原音連在一起，各段的連結不同');
ok(s.selected.length === 8, '切完全部選取');

{
  const video = { id: 'video', name: 'video', kind: 'video' as const, url: 'blob:video', width: 10, height: 10, duration: 10, thumb: '', hasAudio: true };
  const clip = { id: 'sound-clip', mediaId: video.id, track: 0, start: 0, duration: 2, in: 0, fit: 'cover' as const, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }, keys: {}, remap: { moduleId: 'remap-speed', params: {} }, transitionIn: null, transitionOut: null, volume: 1, link: 'pair' };
  const audio = { id: 'sound-track', mediaId: video.id, track: 0, start: 0, duration: 2, in: 0, volume: 1, fadeIn: 0, fadeOut: 0, link: 'pair' };
  useStore.setState({
    media: [video], clips: [clip], audios: [audio], effects: [],
    tracks: { video: [{}], fx: [], audio: [{}] },
    selection: { type: 'audio', id: audio.id }, selected: [`audio:${audio.id}`],
  });
  resetHistory();
  ok(useStore.getState().removeClipAudio(clip.id), '移除影片原音成功');
  ok(useStore.getState().clips[0].volume === 0 && useStore.getState().audios.length === 0, '靜音原音並移除連結音訊');
  undo();
  ok(useStore.getState().audios.length === 1 && useStore.getState().clips[0].volume === 1, '復原影片原音移除');
  useStore.setState({ tracks: { video: [{ locked: true }], fx: [], audio: [{}] } });
  ok(!useStore.getState().removeClipAudio(clip.id), '鎖定軌道不允許移除聲音');
  useStore.setState({
    clips: [{ ...clip, id: 'other-clip', link: 'shared' }, { ...clip, link: 'shared' }],
    audios: [{ ...audio, link: 'shared' }],
    tracks: { video: [{}, {}], fx: [], audio: [{}] },
  });
  ok(useStore.getState().removeClipAudio(clip.id), '共用影音連結可移除單一影片原音');
  ok(useStore.getState().audios.length === 1 && useStore.getState().clips.find((c) => c.id === 'other-clip')?.link === 'shared', '保留其他影片共用的連結音訊');
}

console.warn = warn;
console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
if (fails) process.exit(1);
