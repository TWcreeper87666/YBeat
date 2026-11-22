import { strict as assert } from 'node:assert';
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
import { audioSignal, remapDriveTracks } from '../src/engine/audioReact';
import { DEFAULT_TRACKS } from '../src/engine/tracks';

// 兩個素材：loud 音量 0.9、soft 音量 0.3（整段固定）
const peaks = (v: number) => Array.from({ length: 1000 }, () => v);
const media = new Map<string, any>([
  ['loud', { id: 'loud', kind: 'audio', peaks: peaks(0.9), peaksPerSec: 100 }],
  ['soft', { id: 'soft', kind: 'video', peaks: peaks(0.3), peaksPerSec: 100 }],
]);
const audio = (track: number, mediaId: string, link?: string) => ({ id: `a${track}${mediaId}`, mediaId, track, start: 0, duration: 5, in: 0, volume: 1, ...(link ? { link } : {}) });
const clip = (track: number, mediaId: string, link?: string) => ({ id: `c${track}`, mediaId, track, start: 0, duration: 5, in: 0, volume: 1, ...(link ? { link } : {}) });
const tracks = { ...DEFAULT_TRACKS, video: [{}, {}], audio: [{}, {}] };

{
  // 音訊 1 = loud；影片 2 = soft（影片片段本身的聲音）
  const s: any = { audios: [audio(0, 'loud')], clips: [clip(1, 'soft')], media, tracks, linked: new Set() };
  assert.equal(audioSignal(s, 1).level, 0.9, '沒有來源 = 全部取最大');
  assert.equal(audioSignal(s, 1, { video: [1] }).level, 0.3, '只聽影片 2');
  assert.equal(audioSignal(s, 1, { audio: [0] }).level, 0.9, '只聽音訊 1');
  assert.equal(audioSignal(s, 1, { audio: [1] }).level, 0, '選的軌道沒聲音 = 0');
  assert.equal(audioSignal(s, 1, { audio: [], video: [] }).level, 0.9, '都沒選 = 全部');
}
{
  // 影片 1 的聲音分離成音訊片段（放在音訊 2）：選影片 1 才聽得到
  const s: any = { audios: [audio(1, 'loud', 'L')], clips: [clip(0, 'loud', 'L')], media, tracks, linked: new Set(['L']) };
  assert.equal(audioSignal(s, 1, { video: [0] }).level, 0.9, '連結的音訊算影片軌的');
  assert.equal(audioSignal(s, 1, { audio: [1] }).level, 0, '不算它所在的音訊軌');
}
console.log('PASS 音訊反應的來源');

{
  const drive = (from?: any) => ({ source: 'level' as const, min: 0, max: 1, ...(from ? { from } : {}) });
  const fx: any = { id: 'f', track: 0, audio: { a: drive({ audio: [0, 2], video: [1] }), b: drive() }, stack: [{ id: 's', audio: { c: drive({ audio: [2] }) } }] };
  const c: any = { id: 'c', track: 0, effects: [{ id: 'e', audio: { d: drive({ audio: [1] }) } }] };
  // 刪掉音訊 2（索引 1），後面的往前補
  const r = remapDriveTracks({ clips: [c], effects: [fx] }, 'audio', (j) => (j === 1 ? null : j > 1 ? j - 1 : j));
  assert.deepEqual(r.effects[0].audio!.a.from, { audio: [0, 1], video: [1] }, '索引往前補');
  assert.equal(r.effects[0].audio!.b, fx.audio.b, '沒設來源的不動');
  assert.deepEqual(r.effects[0].stack![0].audio!.c.from, { audio: [1] }, '疊加的特效也改');
  assert.equal(r.clips[0].effects![0].audio!.d.from, undefined, '來源全被刪 = 回到全部');
  const same = remapDriveTracks({ clips: [c], effects: [fx] }, 'video', (j) => j);
  assert.equal(same.clips[0], c, '沒變就原樣回傳');
}
console.log('PASS 軌道變動時來源跟著換');
