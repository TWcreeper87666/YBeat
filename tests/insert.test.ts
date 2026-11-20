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

// 拖素材到片段上：只取代這個片段的素材，位置 / 變換 / 特效保留
{
  const vid = { id: 'vid', name: 'v', kind: 'video', url: '', width: 100, height: 100, duration: 1.5, thumb: '', hasAudio: true };
  const img2 = { ...img, id: 'img2' };
  const a = { ...clipAt('a', 0, 2, 3), transform: { x: 0.2, y: 0, scaleX: 1.5, scaleY: 1.5, rotation: 10, opacity: 1 }, effects: [{ id: 'f', moduleId: 'fx', params: {} }] };
  const b = clipAt('b', 0, 6, 3);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useStore.setState({ media: [img as any, img2 as any, vid as any], clips: [a as any, b as any], audios: [], effects: [], tracks: { video: [{}], fx: [], audio: [{}] }, selection: null, selected: [] });
  ok(useStore.getState().replaceClipMedia('a', 'img2'), '圖片換圖片：成功');
  let s = useStore.getState();
  let na = s.clips.find((c) => c.id === 'a')!;
  const nb = s.clips.find((c) => c.id === 'b')!;
  ok(na.mediaId === 'img2' && na.start === 2 && na.duration === 3 && na.transform.scaleX === 1.5 && na.effects?.length === 1, '位置、長度、變換、片段特效都保留');
  ok(nb.mediaId === 'img', '同一個素材的其他片段不受影響');
  ok(useStore.getState().replaceClipMedia('a', 'vid'), '圖片換成影片：成功');
  s = useStore.getState();
  na = s.clips.find((c) => c.id === 'a')!;
  ok(na.mediaId === 'vid' && Math.abs(na.duration - 1.5) < 1e-9 && na.in === 0, '影片比片段短：長度縮到影片長度');
  const la = s.audios.find((x) => x.link === na.link);
  ok(!!na.link && !!la && la.start === 2 && Math.abs(la.duration - 1.5) < 1e-9, '有聲音的影片：一起放連結的音訊');
  ok(useStore.getState().replaceClipMedia('a', 'img'), '影片換回圖片：成功');
  s = useStore.getState();
  na = s.clips.find((c) => c.id === 'a')!;
  ok(!na.link && s.audios.length === 0, '換成圖片：原本連結的音訊拿掉');
}

// 時間軸片段拖曳：覆蓋會分割並保留素材入點，插入會分割並波紋右移。
{
  const vid = { ...img, id: 'long', kind: 'video', duration: 30, hasAudio: true };
  const target = { ...clipAt('target', 0, 2, 8), mediaId: 'long', in: 1, rate: 1, link: 'pair', remap: { moduleId: 'remap-speed', params: { speed: 2 } } };
  const audio = { id: 'sound', mediaId: 'long', track: 0, start: 2, duration: 8, in: 1, rate: 2, volume: 1, fadeIn: 0, fadeOut: 0, link: 'pair' };
  const dropped = clipAt('dropped', 0, 4, 2);
  const later = clipAt('later', 0, 11, 1);
  const reset = () => useStore.setState({ media: [img as any, vid as any], clips: [target as any, dropped as any, later as any], audios: [audio as any], effects: [], tracks: { video: [{}], fx: [], audio: [{}] }, selected: ['clip:dropped'] });
  reset();
  useStore.getState().resolveTimelineDrop(['clip:dropped'], 'overwrite');
  let s = useStore.getState();
  let pieces = s.clips.filter((c) => c.mediaId === 'long').sort((a, b) => a.start - b.start);
  let sounds = s.audios.sort((a, b) => a.start - b.start);
  ok(pieces.length === 2 && pieces[0].start === 2 && pieces[0].duration === 2 && pieces[1].start === 6 && pieces[1].duration === 4 && pieces[1].in === 9, '覆蓋：變速影片中段切開，右段素材入點正確');
  ok(sounds.length === 2 && sounds[1].start === 6 && sounds[1].in === 9 && pieces[1].link === sounds[1].link && pieces[0].link !== pieces[1].link, '覆蓋：連結音訊同步切開並重新配對');
  reset();
  useStore.getState().resolveTimelineDrop(['clip:dropped'], 'insert');
  s = useStore.getState();
  pieces = s.clips.filter((c) => c.mediaId === 'long').sort((a, b) => a.start - b.start);
  sounds = s.audios.sort((a, b) => a.start - b.start);
  ok(pieces.length === 2 && pieces[0].start === 2 && pieces[0].duration === 2 && pieces[1].start === 6 && pieces[1].duration === 6 && pieces[1].in === 5, '插入：切開片段並把右段推到拖入片段後');
  ok(s.clips.find((c) => c.id === 'later')?.start === 13 && sounds[1].start === 6 && sounds[1].in === 5 && pieces[1].link === sounds[1].link, '插入：後續片段與連結音訊同步波紋右移');
}

{
  const fx = (id: string, start: number, duration: number) => ({ id, moduleId: 'fx', params: {}, track: 0, start, duration, keys: { amount: [{ id: 'k0', t: 0, v: 0, ease: [0, 0, 1, 1] }, { id: 'k1', t: duration, v: 1, ease: [0, 0, 1, 1] }] } });
  useStore.setState({ clips: [], audios: [], effects: [fx('under', 2, 8) as any, fx('move', 4, 2) as any], tracks: { video: [{}], fx: [{}], audio: [{}] } });
  useStore.getState().resolveTimelineDrop(['effect:move'], 'overwrite');
  let kept = useStore.getState().effects.filter((x) => x.id !== 'move').sort((a, b) => a.start - b.start);
  ok(kept.length === 2 && kept[0].duration === 2 && kept[1].start === 6 && kept[1].keys?.amount?.[0].t === 0, '特效軌覆蓋：切開並重設右段關鍵影格時間');
  useStore.setState({ clips: [], audios: [], effects: [fx('under', 2, 8) as any, fx('move', 4, 2) as any], tracks: { video: [{}], fx: [{}], audio: [{}] } });
  useStore.getState().resolveTimelineDrop(['effect:move'], 'insert');
  kept = useStore.getState().effects.filter((x) => x.id !== 'move').sort((a, b) => a.start - b.start);
  ok(kept.length === 2 && kept[1].start === 6 && kept[1].duration === 6, '特效軌插入：右段波紋右移');
}

// 全軌插入只移動插入點右側；跨過插入點的片段會切開。
{
  const audio = { id: 'music', mediaId: 'img', track: 0, start: 5, duration: 2, in: 0, volume: 1, fadeIn: 0, fadeOut: 0 };
  const effect = { id: 'fx', moduleId: 'fx', params: {}, track: 0, start: 4, duration: 3 };
  useStore.setState({ clips: [clipAt('under', 0, 2, 8) as any, clipAt('move', 0, 4, 2) as any, clipAt('other', 1, 3, 4) as any, clipAt('before', 1, 0, 2) as any], audios: [audio as any], effects: [effect as any], tracks: { video: [{}, {}], fx: [{}], audio: [{}] } });
  useStore.getState().resolveTimelineDrop(['clip:move'], 'insertAll');
  const s = useStore.getState();
  const under = s.clips.filter((c) => c.id === 'under' || (c.mediaId === 'img' && c.track === 0 && c.id !== 'move'));
  const other = s.clips.filter((c) => c.track === 1 && c.id !== 'before').sort((a, b) => a.start - b.start);
  ok(under.some((c) => c.start === 6 && c.duration === 6), '全軌插入：目標軌右段往後移');
  ok(other.length === 2 && other[0].start === 3 && other[0].duration === 1 && other[1].start === 6 && other[1].duration === 3, '全軌插入：其他軌跨越插入點的片段切開並後移');
  ok(s.audios[0].start === 7 && s.effects[0].start === 6, '全軌插入：音訊與特效軌也一起後移');
  ok(s.clips.find((c) => c.id === 'before')?.start === 0, '全軌插入：插入點前的片段不動');
}

// Ctrl+V 使用目前選中的軌道，不沿用複製來源軌道。
{
  useStore.setState({ clips: [clipAt('source', 0, 0, 2) as any], audios: [], effects: [], tracks: { video: [{}, {}], fx: [], audio: [] }, selected: [], selection: null, activeTrack: { kind: 'video', idx: 0 }, time: 4 });
  useStore.getState().select({ type: 'clip', id: 'source' });
  ok(useStore.getState().activeTrack?.idx === 0, '選中片段同步選中來源軌道');
  useStore.getState().copy();
  useStore.getState().setActiveTrack({ kind: 'video', idx: 1 });
  useStore.getState().paste();
  const pasted = useStore.getState().clips.find((c) => c.id !== 'source');
  ok(pasted?.track === 1 && pasted.start === 4, '貼上使用目前軌道與播放頭');
  useStore.getState().select({ type: 'clip', id: pasted!.id });
  ok(useStore.getState().activeTrack?.idx === 1, '選中貼上片段同步選中目標軌道');

  useStore.setState({ clips: [clipAt('source', 0, 0, 2) as any, clipAt('occupied', 1, 2, 6) as any, clipAt('later', 1, 9, 2) as any], selected: [], selection: null, activeTrack: { kind: 'video', idx: 1 }, time: 4 });
  const choice = useStore.getState().paste();
  ok(choice?.conflict === true && choice.preview[0]?.track === 1 && choice.preview[0]?.start === 4 && useStore.getState().clips.length === 3, '貼上撞到片段：回傳目標位置預覽，不先修改時間軸');
  useStore.getState().paste(undefined, 'insert');
  const inserted = useStore.getState().clips.find((c) => !['source', 'occupied', 'later'].includes(c.id) && c.start === 4);
  const pieces = useStore.getState().clips.filter((c) => c.id === 'occupied' || (c.track === 1 && c.start === 6 && c.duration === 4));
  ok(inserted?.track === 1 && inserted.duration === 2, '貼上到被佔用的位置：片段仍從播放頭開始');
  ok(pieces.length === 2 && pieces.some((c) => c.start === 2 && c.duration === 2) && pieces.some((c) => c.start === 6 && c.duration === 4), '貼上到被佔用的位置：原片段切開並後移');
  ok(useStore.getState().clips.find((c) => c.id === 'later')?.start === 11 && useStore.getState().clips.find((c) => c.id === 'source')?.start === 0, '貼上插入：同軌後續片段移動，其他軌不動');

  useStore.setState({ clips: [clipAt('source', 0, 0, 2) as any, clipAt('occupied', 1, 2, 6) as any], selected: [], selection: null, activeTrack: { kind: 'video', idx: 1 }, time: 4 });
  useStore.getState().paste(undefined, 'overwrite');
  ok(useStore.getState().clips.some((c) => c.track === 1 && c.start === 4 && c.duration === 2)
    && useStore.getState().clips.some((c) => c.track === 1 && c.start === 6 && c.duration === 2), '貼上覆蓋：只取代重疊的時間範圍');
}

// 短空隙可修剪或加速；沒有空隙時不能套用。
{
  const vid = { ...img, id: 'vid-long', kind: 'video', duration: 20 };
  const source = { ...clipAt('source', 0, 0, 4), mediaId: 'vid-long', link: 'pair' };
  const sound = { id: 'sound', mediaId: 'vid-long', track: 0, start: 0, duration: 4, in: 0, rate: 1, volume: 1, fadeIn: 0, fadeOut: 0, link: 'pair' };
  const reset = () => useStore.setState({ media: [img as any, vid as any], clips: [source as any, clipAt('next', 1, 7, 2) as any], audios: [sound as any], effects: [], tracks: { video: [{}, {}], fx: [], audio: [{}] }, selection: null, selected: [], activeTrack: { kind: 'video', idx: 1 }, time: 5 });
  reset();
  useStore.getState().select({ type: 'clip', id: 'source' });
  useStore.getState().copy();
  useStore.getState().setActiveTrack({ kind: 'video', idx: 1 });
  const choice = useStore.getState().paste();
  ok(choice?.conflict === true && choice.fit?.duration === 2 && choice.fit.speed, '短空隙：貼上選單可修剪或加速至 2 秒');
  useStore.getState().paste(undefined, 'trimFit');
  let pasted = useStore.getState().clips.find((c) => !['source', 'next'].includes(c.id))!;
  ok(pasted.start === 5 && pasted.duration === 2 && Number(pasted.remap.params.speed ?? 1) === 1, '修剪以符合：只縮短片段長度');
  ok(useStore.getState().audios.find((a) => a.link === pasted.link)?.duration === 2, '修剪以符合：連結原音同步縮短');
  reset();
  useStore.getState().paste(undefined, 'speedFit');
  pasted = useStore.getState().clips.find((c) => !['source', 'next'].includes(c.id))!;
  ok(pasted.start === 5 && pasted.duration === 2 && Number(pasted.remap.params.speed) === 2, '加速以符合：片段變速後塞入空隙');
  ok(useStore.getState().audios.find((a) => a.link === pasted.link)?.rate === 2, '加速以符合：連結原音同步加速');
  reset();
  useStore.getState().patchItems({ 'clip:source': { start: 5, track: 1 }, 'audio:sound': { start: 5 } });
  ok(useStore.getState().dropFit(['clip:source', 'audio:sound'])?.duration === 2, '拖曳選單也提供修剪與加速的空隙長度');
  useStore.getState().resolveTimelineDrop(['clip:source', 'audio:sound'], 'speedFit');
  ok(useStore.getState().clips.find((c) => c.id === 'source')?.duration === 2, '拖曳加速以符合：套用到拖曳片段');
  ok(useStore.getState().audios.find((a) => a.id === 'sound')?.rate === 2, '拖曳加速以符合：連結原音保持同步');
}

// Ctrl+D 固定接在原片段尾端；遇到其他片段時由選單模式決定。
{
  const reset = () => useStore.setState({ clips: [clipAt('source', 0, 0, 2) as any, clipAt('next', 0, 3, 2) as any], audios: [], effects: [], tracks: { video: [{}], fx: [], audio: [] }, selection: null, selected: [], time: 0 });
  reset();
  useStore.getState().select({ type: 'clip', id: 'source' });
  const choice = useStore.getState().duplicate();
  ok(choice?.conflict === true && choice.fit?.duration === 1 && choice.preview[0]?.start === 2 && useStore.getState().clips.length === 2, '再製撞到後續片段：回傳原片段尾端預覽，原內容不動');
  useStore.getState().duplicate('trimFit');
  ok(useStore.getState().clips.some((c) => c.id !== 'source' && c.id !== 'next' && c.start === 2 && c.duration === 1), '再製修剪以符合：填滿原片段後的空隙');
  reset();
  useStore.getState().select({ type: 'clip', id: 'source' });
  useStore.getState().duplicate('insert');
  ok(useStore.getState().clips.some((c) => c.id !== 'source' && c.id !== 'next' && c.start === 2 && c.duration === 2)
    && useStore.getState().clips.find((c) => c.id === 'next')?.start === 5, '再製插入：固定接在原片段尾端並後移同軌片段');
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
if (fails) process.exit(1);
