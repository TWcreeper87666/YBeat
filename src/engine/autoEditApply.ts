/**
 * 自動剪輯的套用端：選的歌（放在時間軸最後面）→ 分析 → planEdit → 換成秒數 → Proposal（add_items，一步復原）。
 * 計畫本身（拍號）由 autoEdit.ts 產生；這裡只負責拍號 ↔ 時間軸秒數、片段 / 特效方塊的細節。
 */
import { attachedAudioIds, makeClip, projectDuration, makeTextClip, uid, useStore, type AudioClip, type Clip, type ClipFx, type FxItem, type Media } from '../store';
import { beatSource, mediaBeats, type Beat } from './beats';
import { getAudioBuffer } from './audio';
import { analyzeMusic, bandEnvelopes, type Bands, type MusicInfo } from './musicAnalysis';
import { DEFAULT_OPTIONS, planEdit, popSlots, type EditPlan, type PlanMedia, type PlanOptions, type PlanZone, type Recipe, type RuleOpt, type FxRule } from './autoEdit';
import { loadAnalysis, saveAnalysis } from './analysisStore';
import { aeFootage, aeSong, footage, lastTake, trWeight, songClip, songKey, songMedia, useAutoEdit, type AeSong, type AeZone, type AutoEditSettings, type Footage } from './autoEditSettings';
import { $t, displayName } from '../i18n';
import { create } from 'zustand';
import { sampleAll, type Sampled } from './mediaSampler';
import { shapeMusic } from './energyShape';
import { expandPop, keepFace, LOOSE_MAX, LOOSE_MIN, popFraming, scoreMatte, traceMatte, type PlanPop, type PopLayer, type PopVariant } from './subjectPop';
import { DEFAULT_MASK, maskKey, PATH_SHAPE } from './mask';
import { CLIP_MASK_ID } from '../modules/extra';
import { beatTimeF } from './speedRamp';
import { ensureMatte, matteAt, MATTE_SIZE } from './matte';
import type { Keyframe } from './keyframes';
import { directMedia, directorShots } from '../ai/director';
import { countdown } from '../ai/gemini';
import { bestFace, freeRoom, peopleScore, type FaceBox } from './mediaAnalysis';
import { confidentLead, findLead, followableLead, isLead, leadInfo, leadShare, pickedLead, refineLead, type Lead } from './faceLead';
import { padBox } from './faceTrack';
import { aiErrorText, toAiError, useAiSettings } from '../ai/assistant';
export { useAutoEdit, type AutoEditSettings };
import { fxGroup, intensityParams, transitionOpt } from './autoEditPools';
import { fxCombo, usePrefs } from '../prefs';
import { newKey } from './keyframes';
import { cropClip, cropWindow, fitSize, intoCrop, outOfCrop, type Crop } from './transform';
import { isHitFx, parseDuration } from './params';
import type { Module } from '../modules/builtin';
import { snapFrame } from './rulerTicks';
import { applyProposals, type Proposal } from '../ai/projectTools';
import { beginHistoryTransaction, endHistoryTransaction } from './history';
import { beatLead } from '../ui/beatGrid';
import { hasChance, type FxTrigger } from './trigger';

type S = ReturnType<typeof useStore.getState>;

export { aeFootage, aeSong, footage, songMedia, type Footage };

export interface MusicSource {
  audio: AudioClip;
  media: Media;
  /** 片段範圍內的節拍（素材秒數） */
  beats: Beat[];
  /** 第 i 拍在時間軸上的秒數；0 = 片段開頭、beats.length = 片段結尾 */
  time: (i: number) => number;
}

/** 音樂片段的節拍（clip = 時間軸上的片段 id，或還沒放上去的片段） */
export function musicSource(s: S, clip: string | AudioClip): MusicSource | null {
  const audio = typeof clip === 'string' ? s.audios.find((a) => a.id === clip) : clip;
  const media = audio && s.media.find((m) => m.id === audio.mediaId);
  const info = mediaBeats(media);
  if (!audio || !media || !info) return null;
  const rate = audio.rate || 1;
  const end = audio.in + audio.duration * rate;
  const beats = info.beats.filter((b) => b.t >= audio.in - 1e-6 && b.t < end);
  if (beats.length < 8) return null;
  const lead = beatLead();
  const t0 = audio.start, t1 = audio.start + audio.duration;
  const raw = beats.map((b, i) => (i === 0 ? t0 : snapFrame(audio.start + (b.t - audio.in) / rate - lead)));
  // 保證遞增（對齊格線後可能撞在一起）
  for (let i = 1; i < raw.length; i++) raw[i] = Math.max(raw[i], raw[i - 1] + 1 / 60);
  const time = (i: number) => (i <= 0 ? t0 : i >= raw.length ? t1 : Math.min(raw[i], t1));
  return { audio, media, beats, time };
}

const bandCache = new WeakMap<AudioBuffer, Bands>();
async function bandsOf(m: Media): Promise<Bands | undefined> {
  const buf = await getAudioBuffer(m.url).catch(() => null);
  if (!buf) return undefined;
  let b = bandCache.get(buf);
  if (!b) {
    const n = buf.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    b = bandEnvelopes(mono, buf.sampleRate);
    bandCache.set(buf, b);
  }
  return b;
}

const musicCache = new Map<string, MusicInfo>();
/** 音樂分析的快取鍵（同一首歌、同一段範圍 = 同一份分析） */
export const musicKey = (src: MusicSource) => `${src.media.id}:${src.beats[0].t}:${src.beats.length}`;
/** 歌還沒放上時間軸時的節拍（面板、AI 工具看分析用；時間 0 開始） */
export const songSource = (s: S, song: AeSong) => musicSource(s, songClip(song, 0, 'song'));
export async function analyzeSource(src: MusicSource): Promise<MusicInfo> {
  const key = musicKey(src);
  const shown = `${src.audio.mediaId}:${src.audio.in}:${src.audio.duration}`;
  const hit = musicCache.get(key) ?? await loadAnalysis<MusicInfo>('music', key);
  if (hit) {
    musicCache.set(key, hit);
    if (useAutoEdit.getState().analysis?.info !== hit) useAutoEdit.getState().set({ analysis: { key: shown, info: hit } });
    return hit;
  }
  const bands = await bandsOf(src.media);
  const info = analyzeMusic(src.beats, src.media.peaks ?? [], src.media.peaksPerSec || 100, bands);
  musicCache.set(key, info);
  void saveAnalysis('music', key, info);
  useAutoEdit.getState().set({ analysis: { key: shown, info } });
  return info;
}

export function planFor(src: MusicSource, music: MusicInfo, media: Media[], recipe: Recipe, seed: number, options: PlanOptions = DEFAULT_OPTIONS, range?: [number, number], extra?: Map<string, Partial<PlanMedia>>): EditPlan {
  const n = src.beats.length;
  const pm: PlanMedia[] = media.map((m) => {
    const x = extra?.get(m.id);
    // 影片的一格（主體跳出用）：編排時當成圖片
    const video = m.kind === 'video' && !x?.popOnly;
    return { ...x, id: m.id, kind: video ? 'video' : 'image', duration: video ? m.duration : Infinity };
  });
  return planEdit({ beats: src.beats.map((b, i) => ({ t: src.time(i), down: b.down })), music, media: pm, recipe, seed, options, range: range ?? [0, n] });
}

/** 最近幾次主體跳出的種類（跨「再一版」輪流用；重新整理就清掉） */
let recentPops: PopVariant[] = [];
/** 最近幾版主體跳出用過的素材（主體、揭露畫面）和影片格（原素材 + 秒數） */
let recentPopMedia: string[] = [];
let recentPopFrames: { src: string; t: number }[] = [];
const RECENT_POPS = 30;

/** 使用者標的副歌（歌的秒數）→ 最近的拍號（在這段範圍外的不算） */
export function chorusBeats(chorus: number[] | undefined, beats: { t: number }[]): number[] {
  const n = beats.length;
  if (!n || !chorus?.length) return [];
  const first = beats[0].t, last = beats[n - 1].t;
  const out: number[] = [];
  for (const t of chorus) {
    if (t < first - 0.5 || t > last + 0.5) continue;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(beats[i].t - t) < Math.abs(beats[best].t - t)) best = i;
    out.push(best);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** 歌上的副歌點（歌的秒數）：手動標的（auto = false），或沒標時自動找的主體跳出位置 */
export function songChorus(song: AeSong, beats: { t: number }[], music: MusicInfo | null): { auto: boolean; t: number[] } {
  const manual = (song.chorus ?? []).filter((t) => t >= song.a - 0.5 && t <= song.b + 0.5);
  if (manual.length) return { auto: false, t: manual };
  if (!music || !beats.length) return { auto: true, t: [] };
  const { drops, rises } = popSlots(music, 0, beats.length);
  return { auto: true, t: [...drops, ...rises].sort((a, b) => a - b).map((i) => beats[Math.min(i, beats.length - 1)].t) };
}

/** 改副歌點：還是自動的話先把自動找的點當成手動的，再套用 fn（歌的秒數）；空 = 回到自動 */
export function editChorus(fn: (list: number[]) => number[]) {
  const s = useStore.getState(), st = useAutoEdit.getState();
  const song = aeSong(s, st);
  if (!song) return;
  const src = songSource(s, song);
  const music = src && st.analysis?.key === songKey(song) ? shapeMusic(st.analysis.info, st.shape) : null;
  const cur = songChorus(song, src?.beats ?? [], music).t;
  const next = [...new Set(fn(cur).map((t) => Math.round(Math.max(song.a, Math.min(song.b, t)) * 1000) / 1000))].sort((a, b) => a - b);
  const { chorus: _c, ...rest } = song;
  st.set({ song: next.length ? { ...rest, chorus: next } : rest });
}

/**
 * 自動分段（歌沒有自己的分段時）：開場（第一段）鏡頭長、轉場和特效少（暗角這類常駐的氛圍照樣有）；高潮段（沒有就用副歌點所在的段落）切得密、轉場和特效多。
 * 數字跟著目前的風格算（換風格就跟著變）
 */
export function autoZones(beats: { t: number }[], end: number, music: MusicInfo, p: Recipe, chorus: number[] = []): AeZone[] {
  const secs = music.sections;
  if (secs.length < 2 || !beats.length) return [];
  const tOf = (b: number) => (b >= beats.length ? end : beats[Math.max(0, b)].t);
  const r = (v: number) => Math.round(v * 100) / 100;
  const out: AeZone[] = [];
  const first = secs[0];
  out.push({ id: `auto:${first.b0}`, t0: tOf(first.b0), t1: tOf(first.b1),
    beatsPerShot: Math.min(16, Math.max(4, p.beatsPerShot[0] * 2)), trRate: r(p.transitionRate * 0.4), fxRate: 0.3 });
  let hot = secs.slice(1).filter((x) => x.kind === 'drop');
  if (!hot.length) hot = secs.slice(1).filter((x) => chorus.some((b) => b >= x.b0 && b < x.b1));
  for (const x of hot) out.push({ id: `auto:${x.b0}`, t0: tOf(x.b0), t1: tOf(x.b1),
    beatsPerShot: Math.max(1, p.beatsPerShot[2]), trRate: r(p.sectionTransitionRate), fxRate: 1.5 });
  return out;
}

/** 這首歌的分段：自己的（auto = false），或沒有時照段落自動分的 */
export function songZones(song: AeSong, beats: { t: number }[], music: MusicInfo | null, p: Recipe): { auto: boolean; list: AeZone[] } {
  if (song.zones) return { auto: false, list: song.zones };
  if (!music) return { auto: true, list: [] };
  const chorus = songChorus(song, beats, music).t.map((t) => zoneBeat(t, beats));
  return { auto: true, list: autoZones(beats, song.b, music, p, chorus) };
}

/** 面板目前看到的分段（給 editZones、AI 工具用） */
export function currentZones(s: S = useStore.getState(), st: AutoEditSettings = useAutoEdit.getState()): { auto: boolean; list: AeZone[] } {
  const song = aeSong(s, st);
  if (!song) return { auto: true, list: [] };
  const src = songSource(s, song);
  const music = src && st.analysis?.key === songKey(song) ? shapeMusic(st.analysis.info, st.shape) : null;
  return songZones(song, src?.beats ?? [], music, st.params);
}

lastTake.zones = () => currentZones();

/** 分段改回自動 */
export function resetZones() {
  const st = useAutoEdit.getState();
  const song = aeSong(useStore.getState(), st);
  if (!song?.zones) return;
  const { zones: _z, ...rest } = song;
  st.set({ song: rest });
}

/** 改分段（歌的秒數）：還是自動的話先把自動分的當成自己的；頭尾夾在歌的範圍內、照開頭排序；太短的丟掉；改完是空的 = 不分段 */
export function editZones(fn: (list: AeZone[]) => AeZone[]) {
  const st = useAutoEdit.getState();
  const song = aeSong(useStore.getState(), st);
  if (!song) return;
  const r3 = (t: number) => Math.round(t * 1000) / 1000;
  const next = fn(currentZones(useStore.getState(), st).list)
    .map((z) => ({ ...z, t0: r3(Math.max(song.a, Math.min(song.b, z.t0))), t1: r3(Math.max(song.a, Math.min(song.b, z.t1))) }))
    .filter((z) => z.t1 - z.t0 > 0.05)
    .sort((a, b) => a.t0 - b.t0);
  st.set({ song: { ...song, zones: next } });
}

/** 放進一個新的分段：蓋到的舊分段截掉（整個被蓋住的刪掉、被切成兩半的留兩段） */
export function carveZones(list: AeZone[], z: AeZone): AeZone[] {
  const out: AeZone[] = [];
  for (const o of list) {
    if (o.id === z.id) continue;
    if (o.t1 <= z.t0 || o.t0 >= z.t1) { out.push(o); continue; }
    if (o.t0 < z.t0) out.push({ ...o, t1: z.t0 });
    if (o.t1 > z.t1) out.push({ ...o, id: o.t0 < z.t0 ? uid() : o.id, t0: z.t1 });
  }
  return [...out, z].sort((a, b) => a.t0 - b.t0);
}

/**
 * 鎖住的項目（時間軸秒數）→ 新的一版要空出來的拍號範圍：頭往前取到最近的拍、尾往後取到最近的拍
 * （新的鏡頭只會停在這之前、從這之後開始，不會疊到鎖住的東西）
 */
export function lockedBeats(src: MusicSource, a: number, b: number): [number, number] {
  const n = src.beats.length;
  let b0 = 0;
  while (b0 < n && src.time(b0 + 1) <= a + 1e-3) b0++;
  let b1 = n;
  while (b1 > b0 + 1 && src.time(b1 - 1) >= b - 1e-3) b1--;
  return [b0, b1];
}

/** 時間範圍 → 拍號範圍（頭尾各取範圍內最近的一拍；範圍蓋到片段頭尾就用片段頭尾） */
export function beatRange(src: MusicSource, a: number, b: number): [number, number] | null {
  const n = src.beats.length;
  let b0 = 0;
  while (b0 < n && src.time(b0) < a - 1e-6) b0++;
  let b1 = n;
  while (b1 > b0 && src.time(b1) > b + 1e-6) b1--;
  return b1 - b0 >= 1 ? [b0, b1] : null;
}

/** 計畫 → 片段與特效方塊（時間軸秒數） */
export function planItems(plan: EditPlan, src: MusicSource, s: S, feet: Footage[] = []): { clips: Clip[]; effects: FxItem[] } {
  const T = src.time;
  // 指定片段是虛擬素材（見 aeFootage）：長度 = 片段長度，放上時間軸時換回原素材、入點加上片段起點
  const mediaOf = new Map<string, Footage>([...s.media.map((m) => [m.id, m] as const), ...feet.map((m) => [m.id, m] as const)]);
  const lin = [0, 0, 1, 1] as [number, number, number, number];
  const clips: Clip[] = [];
  for (const sh of plan.shots) {
    const m = mediaOf.get(sh.mediaId);
    const start = T(sh.b0);
    const duration = T(sh.b1) - start;
    if (!m || duration < 1 / 60) continue;
    let inn = 0;
    if (m.kind === 'video') inn = Math.max(0, Math.min(sh.in, m.duration - duration));
    // 變速：素材時間曲線（相對 in）；整條曲線都要在素材範圍內，不然改回常速
    const sp = m.kind === 'video' && sh.speed && sh.in + sh.speed.sourceMin >= -1e-6 && sh.in + sh.speed.sourceMax <= m.duration - 0.02 + 1e-6 ? sh.speed : null;
    if (sp) inn = sh.in;
    const c = makeClip({ mediaId: m.srcId ?? m.id, start, duration, in: inn + (m.from ?? 0), volume: 0 });
    // 有主角：從主角的臉開始追（框選目標），不會跟到同框的別人
    // 有裁切：分析結果是框內座標，追蹤用的框要換回整個畫面
    let anchor = sh.anchor && m.crop ? outOfCrop(sh.anchor, m.crop) : sh.anchor;
    // 鏡頭裡沒有主角：從這個鏡頭中間最大的那張臉開始追（一般的臉部追蹤是整支影片挑一個人，這段可能是別人；有裁切時還可能在框外）
    if (!anchor && sh.face) {
      const cd = m.crop ? cropDims(m, m.crop) : m;
      const f = sh.faceAnchor ?? { ...sh.face, t: m.kind === 'video' ? sh.in + (sp ? (sp.sourceMin + sp.sourceMax) / 2 : duration / 2) : 0 };
      const box = { t: f.t, x: f.x, y: f.y, h: f.h, w: f.w ?? (f.h * (cd.height || 9)) / (cd.width || 16) };
      anchor = m.crop ? outOfCrop(box, m.crop) : box;
    }
    if (anchor) c.subject = { kind: 'box', anchors: [{ t: +(anchor.t + (m.kind === 'video' ? m.from ?? 0 : 0)).toFixed(4), box: padBox(anchor) }] };
    if (sh.face && sh.push) c.keys = facePush(sh.face, m.crop ? cropDims(m, m.crop) : m, s.format.w / s.format.h, duration);
    if (sp) {
      const tb = (beat: number) => beatTimeF(T, beat) - start;
      c.remap = { moduleId: 'remap-curve', params: {}, keys: sp.knots.map((k) => newKey(Math.min(duration, Math.max(0, tb(k.beat))), k.source, k.ease)) };
    }
    if (sh.motion) {
      const { from: a, to: b } = sh.motion;
      c.keys = {
        scaleX: [newKey(0, a.scale, lin), newKey(duration, b.scale, lin)],
        scaleY: [newKey(0, a.scale, lin), newKey(duration, b.scale, lin)],
        x: [newKey(0, a.x, lin), newKey(duration, b.x, lin)],
        y: [newKey(0, a.y, lin), newKey(duration, b.y, lin)],
      };
    }
    // 裁切：框內整個放進畫面（比例跟輸出不同就留邊，框外用片段遮罩擋掉）；推近 / 運鏡是對框內畫面做的，一起換算
    if (m.crop) {
      const src = (m.width || 16) / (m.height || 9), frame = s.format.w / s.format.h;
      c.fit = 'cover';
      Object.assign(c, cropClip(c, m.crop, src, frame, false));
      const win = cropWindow(m.crop, src, frame);
      if (win.w < 0.999 || win.h < 0.999) {
        c.effects = [...(c.effects ?? []), {
          id: uid(), moduleId: CLIP_MASK_ID, params: {}, base: true,
          mask: { ...DEFAULT_MASK, shape: 'rect', invert: false, x: 0, y: 0, w: win.w, h: win.h, feather: 0, rotation: 0 },
        }];
      }
    }
    const prev = clips[clips.length - 1];
    if (sh.transition && prev && Math.abs(prev.start + prev.duration - start) < 1e-6) {
      const beat = T(sh.b0 + 1) - start;
      const d = Math.min(sh.transition.beats * beat, prev.duration, duration);
      if (d >= 1 / 30) c.transitionIn = { moduleId: sh.transition.moduleId, params: {}, duration: d };
    }
    clips.push(c);
  }
  // 主體跳出：揭露拍的完整圖要跟去背的主體對齊（縮放 1、置中開始），推近 / 拉遠改成從原尺寸推近
  const reveal = new Set((plan.pops ?? []).map((p) => p.b1));
  for (const c of clips) {
    const b = plan.shots.find((sh) => Math.abs(T(sh.b0) - c.start) < 1e-6)?.b0;
    if (b === undefined || !reveal.has(b) || !c.keys.scaleX) continue;
    // 放大那一端的縮放與位移（拉遠 = 開頭那一端）
    const i = c.keys.scaleX[0].v >= c.keys.scaleX[c.keys.scaleX.length - 1].v ? 0 : c.keys.scaleX.length - 1;
    const to = c.keys.scaleX[i].v, tx = c.keys.x?.[i]?.v ?? 0, ty = c.keys.y?.[i]?.v ?? 0;
    const end = c.duration;
    c.keys = {
      scaleX: [newKey(0, 1, lin), newKey(end, to, lin)], scaleY: [newKey(0, 1, lin), newKey(end, to, lin)],
      x: [newKey(0, 0, lin), newKey(end, tx, lin)], y: [newKey(0, 0, lin), newKey(end, ty, lin)],
    };
    c.transitionIn = null;
  }
  // 每次主體跳出（去背的那幾層 + 底下的鏡頭 + 揭露的那一個鏡頭）是一個群組：一起選、一起鎖住
  const base = [...clips];
  for (const p of plan.pops ?? []) {
    const group = uid();
    const t0 = T(p.b0), t1 = T(p.b1);
    for (const c of base) if (!c.group && c.start < t1 + 1e-6 && c.start + c.duration > t0 + 1e-6) c.group = group;
    for (const l of expandPop(p, T)) {
      const c = popClip(l, s, p, mediaOf);
      if (c) clips.push({ ...c, group });
    }
  }
  const effects: FxItem[] = [];
  // 特效軌：舊的點綴一層、特效層每層一條（層號小的先套用）
  const lanes = [...new Set(plan.overlays.map((o) => o.lane ?? -1))].sort((a, b) => a - b);
  for (const o of plan.overlays) {
    const start = T(o.b0);
    let duration = T(o.b1) - start;
    const track = lanes.indexOf(o.lane ?? -1);
    const trigger: FxTrigger | undefined = o.trigger
      ? { ...o.trigger }
      : o.everyBeat ? { kind: 'beat', every: 1 } : undefined;
    const combo = fxCombo(o.moduleId);
    if (combo) {
      // 我的組合：整組（主特效 + 疊加 + 觸發）放上去；衝擊型只打一下；特效層的觸發蓋過組合自己的
      const fx = structuredClone(combo.fx);
      const main = s.modules.find((x) => x.id === fx.moduleId);
      if (!main) continue;
      if (!trigger && !fx.trigger && isHitFx(main)) duration = Math.min(duration, fx.duration || parseDuration(main.code, 0.5));
      if (duration < 1 / 60) continue;
      effects.push({ ...fx, name: displayName(combo.name), ...(trigger ? { trigger } : {}), stack: fx.stack?.map((x) => ({ ...x, id: uid() })), id: uid(), start, duration, track });
      continue;
    }
    const mod = s.modules.find((x) => x.id === o.moduleId);
    if (!mod) continue;
    // 衝擊特效只打一下：方塊長度 = 模組的 @duration（不超過計畫的範圍）
    if (!trigger && isHitFx(mod)) duration = Math.min(duration, parseDuration(mod.code, 0.5));
    if (duration < 1 / 60) continue;
    // 特效層指定的參數訊號：跟音量 / 節拍的只聽音樂那一軌；隨機的每個方塊換一個種子
    const audio = o.drive ? Object.fromEntries(Object.entries(o.drive).map(([k, d]) => [k, d.source === 'random'
      ? { ...d, seed: d.seed ?? Math.floor(Math.random() * 2 ** 31) }
      : { ...d, ...(src.audio && !d.from ? { from: { audio: [src.audio.track] } } : {}) }])) : undefined;
    effects.push({ id: uid(), moduleId: o.moduleId, params: { ...(o.params ?? {}) }, start, duration, track, ...(trigger ? { trigger } : {}), ...(audio ? { audio } : {}) });
  }
  return { clips, effects: mergeStacked(effects, s.modules) };
}

/**
 * 範圍、觸發完全一樣的特效方塊合併成一個（後面的變成疊加的特效），空出來的特效軌收掉。
 * 觸發沒設機率時 seed 不算（不影響結果）；有觸發時衝擊長度（主特效的 @duration）要一樣。
 * 中間軌道上跟它重疊的特效會變成在合併的這組之後套用（自動剪輯的層順序本來就是隨意的）。
 */
export function mergeStacked(effects: FxItem[], modules: Module[]): FxItem[] {
  const hitLen = (id: string) => {
    const m = modules.find((x) => x.id === id);
    return m && isHitFx(m) ? parseDuration(m.code, 0.5) : 0;
  };
  const r4 = (x: number) => Math.round(x * 1e4);
  const trigKey = (t: FxItem['trigger']) => {
    if (!t) return null;
    const { seed, ...rest } = t;
    return hasChance(t) ? t : rest;
  };
  const keyOf = (f: FxItem) => `${r4(f.start)}|${r4(f.duration)}|${JSON.stringify(trigKey(f.trigger))}`;
  const alive = effects.map((f) => ({ ...f }));
  const gone = new Set<FxItem>();
  const groups = new Map<string, FxItem[]>();
  for (const f of alive) if (!f.mask && f.subjectFrom === undefined) groups.set(keyOf(f), [...(groups.get(keyOf(f)) ?? []), f]);
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.track - b.track);
    let head = list[0];
    for (const f of list.slice(1)) {
      if (f.track === head.track || (head.trigger && hitLen(head.moduleId) !== hitLen(f.moduleId))) {
        head = f;
        continue;
      }
      const main: ClipFx = { id: uid(), moduleId: f.moduleId, params: f.params, ...(f.keys ? { keys: f.keys } : {}), ...(f.audio ? { audio: f.audio } : {}), ...(f.follow !== undefined ? { follow: f.follow } : {}) };
      head.stack = [...(head.stack ?? []), main, ...(f.stack ?? [])];
      delete head.name; // 合併後不再是單一組合
      gone.add(f);
    }
  }
  const out = alive.filter((f) => !gone.has(f));
  const used = [...new Set(out.map((f) => f.track))].sort((a, b) => a - b);
  return out.map((f) => ({ ...f, track: used.indexOf(f.track) }));
}

/**
 * 推近到臉上：結束時臉的高度約畫面的 FACE_FILL（縮放 1.12..1.45），臉盡量移到畫面中間（不露黑邊）；
 * 開頭從比較寬的地方開始。座標跟 mediaToFrame 一樣（x 是畫面寬、y 是畫面高的比例）。
 */
const FACE_FILL = 0.28;
/** 裁切後的畫面大小（像素） */
const cropDims = (m: { width: number; height: number }, c: Crop) => ({ width: (m.width || 16) * c.w, height: (m.height || 9) * c.h });

/** 分析結果換到裁切框內的座標（框外的臉丟掉）：之後的主角、推近、錨點都當成只有框內的畫面 */
export function cropSampled(x: Sampled, c: Crop): Sampled {
  type F = { x: number; y: number; h: number; w?: number };
  const list = <T extends F>(l: T[] | null | undefined) => (l ? l.map((f) => intoCrop(f, c)).filter((f): f is T => !!f) : l);
  let info = x.info;
  if (info) {
    const facesAt = info.facesAt?.map((l) => list(l) ?? null);
    const faces = info.faces?.map((f, i) => {
      const at = facesAt?.[i];
      return at ? bestFace(at) : f ? intoCrop(f, c) : null;
    });
    const people = info.people && faces ? info.people.map((_, i) => (faces[i] ? peopleScore([faces[i]!]) : 0)) : info.people;
    info = { ...info, ...(faces ? { faces } : {}), ...(facesAt ? { facesAt } : {}), ...(people ? { people } : {}) };
  }
  const face = x.face ? intoCrop(x.face, c) : x.face;
  return { ...x, info, face, faceList: list(x.faceList) ?? x.faceList, ...(x.people !== undefined && !face ? { people: 0 } : {}) };
}

export function facePush(f: { x: number; y: number; h: number }, m: { width: number; height: number }, aspect: number, duration: number): Clip['keys'] {
  const [sw, sh] = fitSize(true, (m.width || 1) / (m.height || 1), aspect);
  const at = (k: number) => {
    const mx = Math.max(0, (sw * k / aspect - 1) / 2), my = Math.max(0, (sh * k - 1) / 2);
    const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
    return { k, x: clamp(-(f.x - 0.5) * sw * k / aspect, mx), y: clamp(-(f.y - 0.5) * sh * k, my) };
  };
  const end = Math.max(1.12, Math.min(1.45, FACE_FILL / Math.max(1e-3, f.h * sh)));
  const a = at(1 + (end - 1) * 0.35), b = at(end);
  const lin = [0, 0, 1, 1] as [number, number, number, number];
  return {
    scaleX: [newKey(0, a.k, lin), newKey(duration, b.k, lin)], scaleY: [newKey(0, a.k, lin), newKey(duration, b.k, lin)],
    x: [newKey(0, a.x, lin), newKey(duration, b.x, lin)], y: [newKey(0, a.y, lin), newKey(duration, b.y, lin)],
  };
}

const POP_EASE: Record<string, Keyframe['ease']> = { hold: 'hold', linear: [0, 0, 1, 1], out: [0, 0, 0.58, 1], back: [0.34, 1.56, 0.64, 1] };
/** 主體跳出的一層 → 片段（track = 第幾層，add_items 會換成真正的軌道） */
function popClip(l: PopLayer, s: S, pop: PlanPop, mediaOf: Map<string, Footage>): Clip | null {
  const duration = l.t1 - l.t0;
  if (duration < 1 / 60) return null;
  let c: Clip;
  if (l.text) {
    // 文字層（文字在主體後面）：大字描邊樣式，放在畫面偏上（主體的頭附近）
    c = makeTextClip('outline', s.modules, { start: l.t0, duration, track: l.layer });
    // 字要比主體寬，左右才露得出來（主體擋住中間）
    c.text = { ...c.text!, text: l.text, size: 380 };
    c.transform = { ...c.transform, y: -0.12 };
  } else {
    const m = mediaOf.get(l.mediaId);
    if (!m) return null;
    c = makeClip({ mediaId: m.srcId ?? m.id, start: l.t0, duration, track: l.layer, volume: 0, in: m.kind === 'video' ? m.from ?? 0 : 0, ...(l.matte ? { aiMatte: true } : {}) });
    // 影片的一格：整段停在那一格（揭露那一拍影片從這格接著播）
    if (m.kind === 'video') c.remap = { moduleId: 'remap-curve', params: {}, keys: [newKey(0, 0, 'hold'), newKey(duration, 0, 'hold')] };
  }
  if (l.blend && l.blend !== 'normal') c.blend = l.blend;
  c.keys = Object.fromEntries(Object.entries(l.keys ?? {}).map(([k, list]) => [k, list!.map((x) => newKey(Math.min(duration, Math.max(0, x.t)), x.v, POP_EASE[x.ease] ?? 'hold'))]));
  const fx: ClipFx[] = (l.effects ?? []).filter((e) => s.modules.some((x) => x.id === e.moduleId)).map((e) => ({
    id: uid(), moduleId: e.moduleId, params: { ...e.params },
    ...(e.beatEvery ? { timing: { kind: 'beat' as const, every: e.beatEvery, d: e.hitSec ?? 0.18 } } : {}),
  }));
  // 片段自己的遮罩（剪影窗 / 主體挖洞）：A 的輪廓路徑，框 = 圖片 cover 進畫面後的大小，以主體中心縮放
  const subject = mediaOf.get(pop.mediaId);
  if (l.mask && subject) {
    const { w, h } = coverBox(subject, s.format);
    const keyed = (f: (sc: number) => number) => l.mask!.scale.map((k) => newKey(Math.min(duration, Math.max(0, k.t)), f(k.v), POP_EASE[k.ease] ?? 'hold'));
    fx.push({
      id: uid(), moduleId: CLIP_MASK_ID, params: {}, base: true,
      mask: { ...DEFAULT_MASK, shape: PATH_SHAPE, path: l.mask.path, invert: l.mask.invert, x: 0, y: 0, w, h, feather: 0.004, rotation: 0 },
      keys: {
        [maskKey('w')]: keyed((sc) => w * sc), [maskKey('h')]: keyed((sc) => h * sc),
        [maskKey('x')]: keyed((sc) => pop.cx * (1 - sc)), [maskKey('y')]: keyed((sc) => pop.cy * (1 - sc)),
      },
    });
  }
  if (fx.length) c.effects = fx;
  return c;
}

/** 圖片用 cover 放進畫面後的大小（以畫面寬 / 高為 1） */
function coverBox(m: Media, f: { w: number; h: number }) {
  const k = Math.max(f.w / (m.width || f.w), f.h / (m.height || f.h));
  return { w: ((m.width || f.w) * k) / f.w, h: ((m.height || f.h) * k) / f.h };
}

type PopStats = NonNullable<EditPlan['popStats']> & { why: Partial<Record<PopWhy, number>> };
/** 沒有可用主體的原因（最多的那個） */
function popWhyText(why: PopStats['why']): string {
  const top = (Object.entries(why) as [PopWhy, number][]).sort((a, b) => b[1] - a[1])[0];
  if (!top) return $t('沒有可以抽格的影片');
  const n = Object.values(why).reduce((a, b) => a + b, 0);
  const label = { fail: $t('去背失敗'), small: $t('主體太小'), big: $t('主體太大'), off: $t('主體在畫面外'), noFace: $t('沒有臉'), body: $t('只有頭') }[top[0]];
  return $t('{0} 格都不能用：{1}', n, label);
}
/** 圖片能不能做主體跳出（去背後量主體的位置 / 大小）；同一張圖算一次 */
/** why = 不能用的原因：去背失敗 / 主體太小 / 太大 / 在畫面外 / 沒有臉 / 臉的位置沒有連著身體的主體 */
export type PopWhy = 'fail' | 'small' | 'big' | 'off' | 'noFace' | 'body';
type PopInfo = { ok: boolean; loose?: boolean; centered: boolean; cx: number; cy: number; path?: string; why?: PopWhy };
const popCache = new Map<string, PopInfo>();
/**
 * face = 這一格的臉（原圖座標）：去背結果只留臉連著的那一塊（不會框到背景的樹）；
 * null = 分析過、這格沒有臉（不能用）；undefined = 沒分析臉（整個去背結果照用）
 */
async function popInfo(m: Media, s: S, at = 0, face?: FaceBox | null): Promise<PopInfo> {
  const key = (m.kind === 'video' ? `${m.id}@${at.toFixed(2)}` : m.id) + `:${s.format.w}x${s.format.h}:${face ? `${face.x.toFixed(3)},${face.y.toFixed(3)}` : String(face)}`;
  const hit = popCache.get(key);
  if (hit) return hit;
  const done = (out: PopInfo) => (popCache.set(key, out), out);
  if (face === null) return done({ ok: false, centered: false, cx: 0, cy: 0, why: 'noFace' });
  await ensureMatte(m, [m.kind === 'video' ? at : 0]);
  const raw = matteAt(m, m.kind === 'video' ? at : 0);
  const kept = raw && face ? keepFace(raw.data, MATTE_SIZE, face) : raw?.data;
  if (raw && !kept) return done({ ok: false, centered: false, cx: 0, cy: 0, why: 'body' });
  const d = raw && kept ? { data: kept } : null;
  const score = d ? scoreMatte(d.data, MATTE_SIZE) : null;
  const r = score ? popFraming(score, m.width, m.height, s.format.w, s.format.h) : { ok: false, loose: false, centered: false, cx: 0, cy: 0, area: 0 };
  const why: PopWhy | undefined = r.loose ? undefined : !score ? 'fail' : score.area < LOOSE_MIN ? 'small' : score.area > LOOSE_MAX ? 'big' : 'off';
  // 輪廓路徑（剪影窗 / 主體挖洞用；只有能用的圖才描）
  const path = r.loose && d ? traceMatte(d.data, MATTE_SIZE) : '';
  const out = { ok: r.ok, ...(r.loose && !r.ok ? { loose: true } : {}), centered: r.centered, cx: r.cx, cy: r.cy, ...(path ? { path } : {}), ...(why ? { why } : {}) };
  return done(out);
}
/** 影片最多挑幾格去背；每支最多幾格；揭露後至少要能接著播幾秒 */
const POP_MAX_FRAMES = 8;
const POP_PER_VIDEO = 2;
const POP_ROOM = 4;

/**
 * 影片裡適合做主體跳出的幾格（素材時間，相對指定片段的起點）：
 * 有主角 → 主角的臉最大的那幾格；有臉 → 臉最大的；都沒有 → 影片 30% 的地方。同一支挑的格子至少隔 5 秒。
 */
export function popFrameCandidates(media: Footage[], extra: Map<string, Partial<PlanMedia>>, rng: () => number = () => 0.5, recent: { src: string; t: number }[] = []): { m: Footage; t: number; face?: FaceBox | null }[] {
  type P = { t: number; h: number; face?: FaceBox | null };
  const out: (P & { m: Footage })[] = [];
  for (const m of media) {
    // 有裁切的片段不拿來做主體跳出（去背、對齊都是看整個畫面）
    if (m.kind !== 'video' || m.crop || m.duration < POP_ROOM + 1 || extra.get(m.id)?.weight === 0) continue;
    const x = extra.get(m.id);
    const ok = (t: number) => t <= m.duration - POP_ROOM && !x?.ban?.some(([a, b]) => t >= a - 0.1 && t <= b + POP_ROOM);
    // 臉的位置：去背結果只留這張臉連著的那一塊
    const pts: P[] = x?.leadPts?.length ? x.leadPts.map((p) => ({ t: p.t, h: p.h, face: { x: p.x, y: p.y, w: p.w, h: p.h } }))
      // 只用真的偵測過的格（info.faces 中間的格是借最近一次偵測的位置，人動了框就不準，去背會剪到沒有頭）
      : x?.info?.facesAt ? x.info.facesAt.flatMap((l, i) => { const f = l && bestFace(l); return f ? [{ t: i * x!.info!.step, h: f.h, face: f }] : []; })
        : (x?.info?.faces ?? []).flatMap((f, i) => (f ? [{ t: i * x!.info!.step, h: f.h, face: f }] : []));
    // 沒有臉：分析過 = 不能用（null），沒分析 = 照舊整個去背結果
    const list: P[] = pts.length ? pts : [{ t: m.duration * 0.3, h: 0, face: x?.info?.faces ? null : undefined }];
    const picked: P[] = [];
    // 臉越大越優先，但加一點隨機；前幾版用過的那幾秒往後排（每一版換不同的格）
    const src = m.srcId ?? m.id;
    const used = (t: number) => recent.some((r) => r.src === src && Math.abs(r.t - ((m.from ?? 0) + t)) < 2);
    const score = new Map(list.map((p) => [p, p.h * (0.6 + 0.8 * rng()) * (used(p.t) ? 0.25 : 1)]));
    for (const p of [...list].sort((a, b) => score.get(b)! - score.get(a)!)) {
      if (picked.length >= POP_PER_VIDEO) break;
      if (ok(p.t) && picked.every((q) => Math.abs(q.t - p.t) >= 5)) picked.push(p);
    }
    for (const p of picked) out.push({ m, ...p, h: score.get(p)! });
  }
  return out.sort((a, b) => b.h - a.h).slice(0, POP_MAX_FRAMES).map(({ m, t, face }) => ({ m, t, ...(face !== undefined ? { face } : {}) }));
}

/** 最多替幾張圖去背（第一次要下載模型、每張要算一下） */
const POP_MAX_IMAGES = 20;

// ───────────── 面板設定 / 執行 ─────────────

/** 特效層 → 編排器的特效層（關掉的 / 模組不見了 = null） */
function ruleOpt({ on, ...r }: FxRule, st: AutoEditSettings, s: S): RuleOpt | null {
  const chance = Math.min(1, r.chance * st.density);
  if (!on || chance <= 0) return null;
  const mod = s.modules.find((m) => m.id === r.moduleId && m.kind === 'effect');
  const combo = mod ? undefined : fxCombo(r.moduleId);
  const main = combo && s.modules.find((m) => m.id === combo.fx.moduleId);
  if (!mod && !main) return null; // 模組 / 組合不見了：這層跳過
  return {
    ...r, chance, group: r.drive ? 'ambient' : fxGroup((mod ?? main)!), hit: isHitFx((mod ?? main)!),
    ...(mod && intensityParams(mod.id, st.intensity) ? { params: intensityParams(mod.id, st.intensity) } : {}),
  };
}

/** 轉場清單（ids = 只用這些、權重都是 1；沒有 = 照權重） */
function transitionOpts(st: AutoEditSettings, s: S, ids?: string[]) {
  return s.modules.filter((m) => m.kind === 'transition' && (ids ? ids.includes(m.id) : trWeight(st.trWeights, m.id) > 0))
    .map((m) => ({ ...transitionOpt(m), weight: ids ? 1 : trWeight(st.trWeights, m.id) }));
}

/** 歌的秒數 → 拍號（分段的頭尾已經吸附在拍上；超過最後一拍 = 結尾） */
export function zoneBeat(t: number, beats: { t: number }[]): number {
  const i = beats.findIndex((b) => b.t >= t - 0.05);
  return i < 0 ? beats.length : i;
}

/**
 * 分段 → 編排器的分段 + 分段自己的特效層（span = 那段的拍號）。
 * 分段的特效層接在風格的特效層後面；同一種特效共用一條軌（分段不重疊）
 */
export function zoneOptions(zones: AeZone[] | undefined, beats: { t: number }[], st: AutoEditSettings, s: S, lane0: number): { zones: PlanZone[]; rules: RuleOpt[] } {
  const out: PlanZone[] = [], rules: RuleOpt[] = [];
  const lanes: string[] = [];
  for (const z of zones ?? []) {
    const b0 = zoneBeat(z.t0, beats), b1 = zoneBeat(z.t1, beats);
    if (b1 - b0 < 1) continue;
    out.push({
      b0, b1,
      ...(z.tr !== undefined ? { transitions: z.tr === null ? null : transitionOpts(st, s, z.tr) } : {}),
      ...(z.trRate !== undefined ? { transitionRate: z.trRate } : {}),
      ...(z.fxRate !== undefined ? { fxRate: z.fxRate } : {}),
      ...(z.beatsPerShot ? { beatsPerShot: z.beatsPerShot } : {}),
      ...(z.noPop ? { noPop: true as const } : {}),
      ...(z.noSpeed ? { noSpeed: true as const } : {}),
    });
    for (const r of z.rules ?? []) {
      const o = ruleOpt(r, st, s);
      if (!o) continue;
      if (!lanes.includes(r.moduleId)) lanes.push(r.moduleId);
      rules.push({ ...o, id: `${z.id}:${r.id}`, span: [b0, b1], lane: lane0 + lanes.indexOf(r.moduleId) });
    }
  }
  return { zones: out, rules };
}

/** 設定 → 編排器的選項（只留目前存在的模組 / 組合） */
export function planOptions(st: AutoEditSettings, s: S = useStore.getState()): PlanOptions {
  const tr = transitionOpts(st, s);
  const rules = st.rules.map((r) => ruleOpt(r, st, s)).filter((r): r is RuleOpt => !!r);
  const pops = st.popOn && st.popVariants.length ? { variants: st.popVariants, per32: st.popsPer32, text: st.popText } : undefined;
  const speed = st.speedOn && st.speedVariants.length ? { variants: st.speedVariants, per32: st.speedsPer32, intensity: st.speedIntensity, every: !!st.speedEvery, boost: st.speedBoost ?? 1 } : undefined;
  return { transitions: tr, accents: [], dropHit: null, rules, kenBurns: st.kenBurns, order: st.order, pops, speed };
}

/** 時間軸上標著這一版編號的片段、特效、音樂 */
export function takeItems(s: Pick<S, 'clips' | 'effects' | 'audios'>, id: string) {
  return { clips: s.clips.filter((x) => x.take === id), effects: s.effects.filter((x) => x.take === id), audios: s.audios.filter((x) => x.take === id) };
}
/** 這一版的內容摘要：件數 + 雜湊（手動改過任何一個 = 不一樣） */
export function takeSig(s: Pick<S, 'clips' | 'effects' | 'audios'>, id: string): string {
  const t = takeItems(s, id);
  // 鎖住 / 解鎖不算改過（鎖住之後照樣可以「再一版」）
  const plain = <T extends { locked?: true }>(l: T[]) => l.map(({ locked: _l, ...x }) => x);
  const text = JSON.stringify([plain(t.clips), plain(t.effects), plain(t.audios)]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${t.clips.length + t.effects.length + t.audios.length}:${(h >>> 0).toString(36)}`;
}
let sigMemo: { clips: unknown; effects: unknown; audios: unknown; take: unknown; ok: boolean } | null = null;
/** 上一版還在時間軸上、沒被手動改過（「再一版」會先拿掉上一版）；編號存在專案裡，重新整理後照樣可以 */
export function canReplaceLast(): boolean {
  const take = useAutoEdit.getState().lastTake;
  if (!take) return false;
  const s = useStore.getState();
  const m = sigMemo;
  if (m && m.clips === s.clips && m.effects === s.effects && m.audios === s.audios && m.take === take) return m.ok;
  const sig = takeSig(s, take.id);
  const ok = !sig.startsWith('0:') && sig === take.sig;
  sigMemo = { clips: s.clips, effects: s.effects, audios: s.audios, take, ok };
  return ok;
}
lastTake.replaceable = canReplaceLast;

export type AutoEditError = 'noMusic' | 'noMedia' | 'noKey' | 'empty' | 'cancelled';
/** 進度：音樂 / 素材分析（第幾個、共幾個）/ AI 導演 */
export type AutoEditProgress = { stage: 'music' } | { stage: 'media'; i: number; n: number; name: string; frac: number } | { stage: 'matte'; i: number; n: number; name: string }
  | { stage: 'director'; retry?: { n: number; wait: number; format?: boolean }; files?: number; images?: number; batch?: { done: number; total: number } }
  | { stage: 'directed'; list: { name: string; roles: string[]; weight: number; note: string; use?: [number, number][]; avoid?: [number, number][] }[] }
  | { stage: 'plan' }
  | { stage: 'lead'; files: number; spans: number; skipped: number; unsure?: true; /** 只拿來決定追誰 */ weak?: true; /** 使用者指定的 */ picked?: true; /** 指定的主角在素材裡找不到 */ missing?: true };

/**
 * 依主角改寫素材分析：leadPts = 主角的臉在哪（每個鏡頭從這裡開始追）。
 * strong = 也把分析換成主角的（有沒有人只看主角）、避開只有別人的範圍、只有別人的圖片不用；
 * 不 strong = 只記主角在哪，其他照原本的分析
 */
function applyLead(sampled: Map<string, Sampled>, lead: Lead, strong: boolean) {
  const extra = new Map<string, Partial<PlanMedia>>();
  const notes = new Map<string, (t: number) => string>();
  let files = 0, spans = 0, skipped = 0;
  for (const [id, x] of sampled) {
    if (x.info?.facesAt) {
      const r = leadInfo(x.info, x.info.facesAt, lead);
      const pts = r.states.flatMap((s, i) => {
        const b = s === 'lead' ? x.info!.facesAt![i]!.filter((f) => isLead(f, lead)).sort((p, q) => q.h - p.h)[0] : null;
        return b ? [{ t: i * x.info!.step, x: b.x, y: b.y, w: b.w ?? b.h, h: b.h }] : [];
      });
      if (pts.length) files++;
      if (!strong) {
        extra.set(id, { leadKnown: true, ...(pts.length ? { leadPts: pts } : {}) });
        continue;
      }
      extra.set(id, { info: { ...x.info, faces: r.faces, people: r.people }, people: r.people.reduce((s, v) => s + v, 0) / Math.max(1, r.people.length), ban: r.ban, leadPts: pts, leadKnown: true });
      spans += r.ban.length;
      // 給 AI 導演看：這一格有沒有主角
      const step = x.info.step, sampledIdx = r.states.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
      notes.set(id, (t) => {
        const i = sampledIdx.reduce((best, k) => (Math.abs(k * step - t) < Math.abs(best * step - t) ? k : best), sampledIdx[0] ?? 0);
        const s = r.states[i];
        return s === 'lead' ? ' [main person]' : s === 'others' ? ' [only other people]' : '';
      });
    } else if (x.faceList?.length) {
      const lf = x.faceList.filter((f) => isLead(f, lead)).sort((p, q) => q.h - p.h)[0];
      if (lf) files++;
      const pt = lf ? { leadPts: [{ t: 0, x: lf.x, y: lf.y, w: lf.w ?? lf.h, h: lf.h }] } : {};
      if (!strong) {
        extra.set(id, { leadKnown: true, ...(lf ? { face: lf, ...pt } : {}) });
        continue;
      }
      const others = !lf && x.faceList.some((f) => f.emb);
      if (others) skipped++;
      extra.set(id, { leadKnown: true, face: lf ?? null, people: lf ? Math.min(1, lf.h / 0.25) : 0, ...pt, ...(others ? { weight: 0 } : {}) });
      notes.set(id, () => (lf ? ' [main person]' : others ? ' [only other people]' : ''));
    }
  }
  return { extra, notes, files, spans, skipped, strong };
}

/** 依目前的設定產生一版並套用（一步復原）；replaceLast：上一版之後沒有其他修改 → 先復原上一版 */
export async function runAutoEdit(replaceLast = false, onProgress: (p: AutoEditProgress) => void = () => {}, signal?: AbortSignal): Promise<{ shots: number; effects: number; pops: number; masks?: number; popStats?: PopStats; ramps?: number; rampable?: number; speedSkip?: EditPlan['speedSkip']; warn?: string } | { error: AutoEditError }> {
  const st = useAutoEdit.getState();
  let s = useStore.getState();
  const song = aeSong(s, st);
  const src0 = song && songSource(s, song);
  if (!song || !src0) return { error: 'noMusic' };
  const media = aeFootage(s, st);
  if (!media.length) return { error: 'noMedia' };
  if (st.director && !useAiSettings.getState().key) return { error: 'noKey' };
  const stopped = () => !!signal?.aborted;
  onProgress({ stage: 'music' });
  const music = shapeMusic(await analyzeSource(src0), st.shape);
  if (stopped()) return { error: 'cancelled' };

  // 素材分析（影片）；AI 導演要看圖，圖片也取一張
  const extra = new Map<string, Partial<PlanMedia>>();
  let warn: string | undefined;
  const need = media.filter((m) => st.analyze || st.director);
  const sampled = need.length ? await sampleAll(need, (i, n, name, frac) => onProgress({ stage: 'media', i, n, name, frac }), stopped) : new Map<string, Sampled>();
  if (stopped()) return { error: 'cancelled' };
  for (const m of media) {
    const x = m.crop && sampled.get(m.id);
    if (x) sampled.set(m.id, cropSampled(x, m.crop!));
  }
  if (st.analyze) for (const [id, x] of sampled) extra.set(id, { ...(x.info ? { info: x.info } : {}), ...(x.people !== undefined ? { people: x.people, face: x.face } : {}) });
  // 主角：使用者指定的人，或所有素材裡出現最多的那個人（臉的特徵分群）。
  // 夠明顯（或指定的）= 追他、避開只有別人的片段；只是比別人多 = 只拿來決定追誰
  const notes = new Map<string, (t: number) => string>();
  if (st.analyze) {
    const all = [...sampled.values()].flatMap((x) => [...(x.info?.facesAt ?? []).flatMap((l) => l ?? []), ...(x.faceList ?? [])])
      .filter((f): f is typeof f & { emb: number[] } => !!f.emb);
    const frames = [...sampled.values()].flatMap((x) => [...(x.info?.facesAt ?? []), ...(x.faceList ? [x.faceList] : [])]);
    const found = findLead(all);
    // 指定的主角：先用所有素材裡很像的臉擴充特徵；mixed = 只有別人的片段照樣用（只對準主角）
    const picked = st.lead ? applyLead(sampled, pickedLead(refineLead(st.lead.emb, all)), !st.lead.mixed) : null;
    // 指定的人在這些素材裡都找不到：照自動的來
    const r = picked?.files ? picked
      : confidentLead(found, found ? leadShare(frames, found) : 0) ? applyLead(sampled, found, true)
        : followableLead(found) ? applyLead(sampled, found, false) : null;
    if (r?.files) {
      for (const [id, v] of r.extra) extra.set(id, { ...extra.get(id), ...v });
      for (const [id, f] of r.notes) notes.set(id, f);
      onProgress({ stage: 'lead', files: r.files, spans: r.spans, skipped: r.skipped, ...(r.strong ? {} : { weak: true as const }), ...(r === picked ? { picked: true as const } : {}), ...(st.lead && r !== picked ? { missing: true as const } : {}) });
    } else if (all.length) onProgress({ stage: 'lead', files: 0, spans: 0, skipped: 0, unsure: true, ...(st.lead ? { missing: true as const } : {}) });
  }
  // 主體跳出：替候選圖片去背、量主體；frames = 影片裡拿來做主體跳出的那幾格（當成另外的素材）
  const frames: Footage[] = [];
  // 去背了但不能用的原因（沒有主體跳出時告訴使用者）
  const popWhy: Partial<Record<PopWhy, number>> = {};
  const miss = (w: PopWhy) => (popWhy[w] = (popWhy[w] ?? 0) + 1);
  if (st.popOn && st.popVariants.length) {
    const imgs = media.filter((m) => m.kind === 'image').slice(0, POP_MAX_IMAGES);
    for (let i = 0; i < imgs.length; i++) {
      if (stopped()) return { error: 'cancelled' };
      const m = imgs[i];
      const x = extra.get(m.id);
      onProgress({ stage: 'matte', i: i + 1, n: imgs.length, name: m.name });
      try {
        // 圖片：有分析過就用最大的臉（沒有臉 = 不能用）；有裁切的不做（去背是看整張）
        const pop = await popInfo(m, s, 0, m.crop ? null : x?.face !== undefined ? x.face : undefined);
        if (pop.why) miss(pop.why);
        extra.set(m.id, { ...extra.get(m.id), pop });
      } catch {
        miss('fail');
        // 去背失敗（模型載入失敗之類）：這張不做主體跳出
      }
    }
    // 影片：挑幾格去背（有主角就挑主角的臉最大的那幾格），主體跳出後揭露那一拍直接從這格接著播
    const cands = popFrameCandidates(media, extra, Math.random, recentPopFrames);
    for (let i = 0; i < cands.length; i++) {
      if (stopped()) return { error: 'cancelled' };
      const { m, t, face } = cands[i];
      const real = s.media.find((x) => x.id === (m.srcId ?? m.id));
      if (!real) continue;
      const at = (m.from ?? 0) + t;
      onProgress({ stage: 'matte', i: i + 1, n: cands.length, name: `${m.name} @${t.toFixed(1)}s` });
      try {
        const pop = await popInfo(real, s, at, face);
        if (!pop.ok && !pop.loose) { miss(pop.why ?? 'fail'); continue; }
        const id = `${m.id}@${t.toFixed(2)}`;
        frames.push({ ...m, id, srcId: real.id, from: at, duration: m.duration - t });
        extra.set(id, { pop, popOnly: true, srcId: m.id, ...(extra.get(m.id)?.roles ? { roles: extra.get(m.id)!.roles } : {}) });
      } catch {
        miss('fail');
        // 去背失敗：這格不用
      }
    }
  }
  if (st.director) {
    const picks = directorShots(media, sampled);
    onProgress({ stage: 'director', files: media.length, images: [...picks.values()].reduce((s, l) => s + l.length, 0) });
    try {
      const dir = await directMedia(music, media, sampled, st.directorNote, signal, (n, wait, format) => onProgress({ stage: 'director', retry: { n, wait, format } }),
        (done, total) => onProgress({ stage: 'director', batch: { done, total } }),
        (failed, total, e) => { warn = $t('AI 導演 {0}/{1} 批沒回應，那些素材改用一般分配：{2}', failed, total, aiErrorText(toAiError(e))); },
        (id, t) => notes.get(id)?.(t) ?? '');
      for (const [id, d] of dir) {
        const m = media.find((x) => x.id === id);
        // 能用的部分不到半秒 = 整支不用
        // 導演說要避開的 + 主角辨識說只有別人的，都不用；主角辨識說不用的圖照樣不用
        const prev = extra.get(id);
        const ban = [...(prev?.ban ?? []), ...d.avoid];
        const weight = prev?.weight === 0 || m?.kind === 'video' && ban.length && freeRoom(m.duration, ban) < 0.5 ? 0 : d.weight;
        extra.set(id, { ...prev, roles: d.roles, weight, highlights: d.highlights, ban, popSuit: d.pop });
      }
      onProgress({ stage: 'directed', list: media.filter((m) => dir.has(m.id)).map((m) => ({ name: m.name, ...dir.get(m.id)!, weight: extra.get(m.id)?.weight ?? dir.get(m.id)!.weight })) });
      useAutoEdit.getState().set({ direction: Object.fromEntries(dir) });
    } catch (e) {
      // 導演失敗（額度、網路）：照樣剪，只是沒有 AI 的分配
      warn = $t('AI 導演失敗，改用一般分配：{0}', aiErrorText(toAiError(e)));
    }
  }

  if (stopped()) return { error: 'cancelled' };
  onProgress({ stage: 'plan' });
  // 拿掉上一版 + 放上新的一版 = 一步復原
  const replace = replaceLast && canReplaceLast() ? useAutoEdit.getState().lastTake!.id : null;
  beginHistoryTransaction();
  let ok = false;
  let shots = 0, nfx = 0, plannedPops = 0, masks = 0, ramps = 0, rampable = 0;
  let popStats: PopStats | undefined;
  let speedSkip: EditPlan['speedSkip'];
  try {
    // 再一版：放在上一版的位置；新的一版：接在時間軸最後面（原本有什麼都不管）
    let at = snapFrame(projectDuration(useStore.getState()));
    // 上一版鎖住的東西：先拿下來（新的一版才會放在同樣的軌道上），剪完原封不動放回去
    let kept: { clips: Clip[]; effects: FxItem[]; audios: AudioClip[] } = { clips: [], effects: [], audios: [] };
    if (replace) {
      const old = takeItems(useStore.getState(), replace);
      at = Math.min(...[...old.clips, ...old.effects, ...old.audios].map((x) => x.start));
      kept = { clips: old.clips.filter((x) => x.locked), effects: old.effects.filter((x) => x.locked), audios: old.audios.filter((x) => x.locked) };
      useStore.setState((x) => ({ clips: x.clips.filter((c) => c.take !== replace), effects: x.effects.filter((e) => e.take !== replace), audios: x.audios.filter((a) => a.take !== replace) }));
    }
    s = useStore.getState();
    const take = uid();
    const audio = songClip(song, at, uid(), take);
    const src = musicSource(s, audio);
    if (!src) return { error: 'noMusic' };
    const seed = (Math.random() * 2 ** 31) >>> 0;
    const opts = planOptions(st, s);
    // 分段：這段的轉場 / 特效層 / 鏡頭長度蓋過風格
    const zo = zoneOptions(songZones(song, src.beats, music, st.params).list, src.beats, st, s, opts.rules?.length ?? 0);
    if (zo.zones.length) opts.zones = zo.zones;
    if (zo.rules.length) opts.rules = [...(opts.rules ?? []), ...zo.rules];
    // 鎖住的範圍（拍號）：鏡頭、跳出、變速不排進去；鎖住的特效那幾拍不再疊特效
    const spans = (l: { start: number; duration: number }[]) => l.map((x) => lockedBeats(src, x.start, x.start + x.duration));
    if (kept.clips.length || kept.effects.length) opts.locked = { shots: spans(kept.clips), fx: spans(kept.effects) };
    // 使用者標的副歌：主體跳出只放在這些地方
    const chorus = chorusBeats(song.chorus, src.beats);
    if (opts.pops && chorus.length) opts.pops = { ...opts.pops, at: chorus };
    // 前幾版用過的主體跳出種類：這一版先用還沒出現過的
    if (opts.pops) opts.pops = { ...opts.pops, recent: recentPops, recentMedia: recentPopMedia };
    const plan = planFor(src, music, [...media, ...frames], st.params, seed, opts, undefined, extra);
    recentPops = [...recentPops, ...plan.pops.map((x) => x.variant)].slice(-RECENT_POPS);
    useAutoEditRun.setState({ pops: { key: songKey(song), list: plan.pops.map((x) => ({ b: x.b1, variant: x.variant })) } });
    recentPopMedia = [...recentPopMedia, ...plan.pops.flatMap((x) => [x.mediaId, ...(x.revealMediaId ? [x.revealMediaId] : [])])].slice(-RECENT_POPS);
    recentPopFrames = [...recentPopFrames, ...plan.pops.flatMap((x) => [x.mediaId, x.revealMediaId ?? '']).flatMap((id) => {
      const f = frames.find((m) => m.id === id);
      return f ? [{ src: f.srcId ?? f.id, t: f.from ?? 0 }] : [];
    })].slice(-RECENT_POPS);
    const { clips, effects } = planItems(plan, src, s, [...media, ...frames]);
    if (!clips.length) return { error: 'empty' };
    plannedPops = plan.pops?.length ?? 0;
    masks = plan.pops.filter((x) => x.variant === 'silhouetteWindow' || x.variant === 'subjectHole').length;
    popStats = st.popOn && st.popVariants.length && plan.popStats ? { ...plan.popStats, why: popWhy } : undefined;
    // 歌鎖住了：用鎖住的那一段，不再放一次
    const p: Proposal = { summary: 'auto edit', op: { op: 'add_items', clips: clips.map((c) => ({ ...c, take })), effects: effects.map((e) => ({ ...e, take })), audios: kept.audios.length ? [] : [audio] } };
    applyProposals([p]);
    // 鎖住的放回原位（換成這一版的編號，下次「再一版」照樣保留）
    if (kept.clips.length || kept.effects.length || kept.audios.length) {
      const tag = <T extends { take?: string }>(l: T[]) => l.map((x) => ({ ...x, take }));
      useStore.setState((x) => ({ clips: [...x.clips, ...tag(kept.clips)], effects: [...x.effects, ...tag(kept.effects)], audios: [...x.audios, ...tag(kept.audios)] }));
    }
    useAutoEdit.getState().set({ lastTake: { id: take, sig: takeSig(useStore.getState(), take) } });
    ok = true;
    shots = clips.length;
    nfx = effects.length;
    // 變速：實際套用了幾個鏡頭（曲線有在動的）/ 可以套的影片鏡頭
    if (st.speedOn && st.speedVariants.length) {
      ramps = clips.filter((c) => c.remap?.moduleId === 'remap-curve' && c.remap.keys?.some((k) => k.ease !== 'hold')).length;
      rampable = plan.shots.filter((x) => [...media, ...frames].find((m) => m.id === x.mediaId)?.kind === 'video').length;
      speedSkip = plan.speedSkip;
    }
  } finally {
    endHistoryTransaction(ok);
  }
  return { shots, effects: nfx, pops: plannedPops, ...(masks ? { masks } : {}), ...(popStats ? { popStats } : {}), ...(rampable ? { ramps, rampable, speedSkip } : {}), ...(warn ? { warn } : {}) };
}

/** 執行狀態（面板的進度條）：label = 現在在做什麼、frac = 0..1（null = 不知道要多久）、result = 上一次的結果 */
export interface AutoEditRun {
  running: boolean;
  label: string;
  frac: number | null;
  result: { ok: boolean; text: string } | null;
  /** 這次做了哪些步驟（AI 分頁顯示用；每一步一行） */
  log: string[];
  /** 最近一版的主體跳出：在哪一拍揭露（歌的拍號）、哪一種；key = 哪首歌哪一段（songKey） */
  pops?: { key: string; list: { b: number; variant: PopVariant }[] };
}
export const useAutoEditRun = create<AutoEditRun>(() => ({ running: false, label: '', frac: null, result: null, log: [] }));

const ROLE: Record<string, string> = { intro: '開頭', build: '鋪陳', drop: '高潮', body: '主體', outro: '結尾' };
/** 導演對一個素材的安排（一行） */
const sec = (v: number) => (Math.round(v * 10) / 10).toString();
const spanText = (l: [number, number][]) => l.map(([a, b]) => `${sec(a)}–${sec(b)}s`).join('、');
const directedLine = (d: { name: string; roles: string[]; weight: number; note: string; use?: [number, number][]; avoid?: [number, number][] }) =>
  `${d.name}：${d.weight === 0 ? $t('不用') : d.roles.map((r) => $t(ROLE[r] ?? r)).join(' · ') || $t('主體')}` +
  `${d.weight !== 0 && d.use?.length ? ` · ${$t('用 {0}', spanText(d.use))}` : ''}${d.weight !== 0 && d.avoid?.length ? ` · ${$t('避開 {0}', spanText(d.avoid))}` : ''}` +
  `${d.note ? ` · ${d.note}` : ''}`;
let abort: AbortController | null = null;
export const cancelAutoEdit = () => abort?.abort();

/**
 * 產生一版（進度與結果顯示在自動剪輯面板）；replaceLast = 再一版。
 * quiet：不切到自動剪輯面板（從 AI 分頁開始的，進度顯示在對話裡）。回傳結果（已經在跑 = null）。
 */
export async function generateAutoEdit(replaceLast = false, quiet = false): Promise<{ ok: boolean; text: string; cancelled?: true } | null> {
  if (useAutoEditRun.getState().running) return null;
  abort = new AbortController();
  const set = (p: Partial<AutoEditRun>) => useAutoEditRun.setState(p);
  const step = (line: string) => set({ log: [...useAutoEditRun.getState().log, line] });
  set({ running: true, label: $t('分析音樂…'), frac: null, result: null, log: [] });
  // 從選單開始的也看得到進度
  if (!quiet) void import('../ui/Dock').then((d) => d.useDock.getState().activatePanel('auto')).catch(() => {});
  let lastStep = '';
  // 限流 / 忙碌的等待：狀態列倒數
  let stopTick = () => {};
  const once = (key: string, line: string) => {
    if (key !== lastStep) step(line);
    lastStep = key;
  };
  const done = (result: { ok: boolean; text: string }) => {
    set({ result });
    step(result.text);
    return result;
  };
  try {
    const r = await runAutoEdit(replaceLast, (p) => {
      stopTick();
      if (p.stage === 'director' && p.retry) {
        const n = p.retry.n;
        if (p.retry.format) return void set({ label: $t('AI 回傳的格式有誤，重新請求（第 {0} 次）', n), frac: null });
        stopTick = countdown(p.retry.wait, (left) => set({ label: $t('AI 忙碌，{0} 秒後重試（第 {1} 次）', left, n), frac: null }));
        return;
      }
      if (p.stage === 'directed') {
        for (const d of p.list) step(directedLine(d));
        return;
      }
      if (p.stage === 'lead') {
        if (p.missing) step($t('素材裡找不到指定的主角，改成自動判斷'));
        step(p.unsure ? $t('認不出明顯的主角（臉太少，或好幾個人出現得一樣多）')
          : p.weak ? $t('主角：出現在 {0} 個素材；不夠明顯，只用來決定追誰', p.files)
            : $t(p.picked ? '指定的主角：出現在 {0} 個素材；只有別人的 {1} 段會避開' : '主角：出現在 {0} 個素材；只有別人的 {1} 段會避開', p.files, p.spans) + (p.skipped ? ` · ${$t('{0} 張圖沒有主角，不用', p.skipped)}` : ''));
        return;
      }
      const label = p.stage === 'music' ? $t('分析音樂…')
        : p.stage === 'media' ? $t('分析素材 {0}/{1}：{2}', p.i, p.n, p.name)
          : p.stage === 'matte' ? $t('去背 {0}/{1}：{2}', p.i, p.n, p.name)
            : p.stage === 'plan' ? $t('排鏡頭、疊特效…')
              : p.retry ? $t('AI 忙碌，{0} 秒後重試（第 {1} 次）', p.retry.wait, p.retry.n)
                : p.batch ? $t('AI 導演：{0}/{1} 批', p.batch.done, p.batch.total)
                : p.images !== undefined ? $t('AI 導演在看 {0} 個素材的 {1} 張畫面…', p.files ?? 0, p.images) : $t('AI 導演分配素材…');
      // 重試只顯示在狀態列；分批每完成一批記一行
      if (p.stage === 'director' && p.batch) once(`batch:${p.batch.done}`, label);
      else if (p.stage !== 'director' || !p.retry) once(`${p.stage}:${'i' in p ? p.i : ''}`, label);
      set(p.stage === 'media' ? { label, frac: (p.i - 1 + p.frac) / p.n } : p.stage === 'matte' ? { label, frac: (p.i - 1) / p.n } : { label, frac: null });
    }, abort.signal);
    if ('error' in r) {
      if (r.error === 'cancelled') return { ...done({ ok: false, text: $t('已取消') }), cancelled: true };
      const msg = {
        noMusic: $t('素材庫裡沒有音樂'), noMedia: $t('沒有可用的素材'),
        noKey: $t('AI 導演需要 API 金鑰'), empty: $t('沒有產生任何片段'),
      }[r.error];
      return done({ ok: false, text: msg });
    } else {
      let base = r.pops ? $t('已產生 {0} 個鏡頭、{1} 個主體跳出', r.shots, r.pops) : $t('已產生 {0} 個鏡頭', r.shots);
      if (r.masks) base += $t('（遮罩 {0}）', r.masks);
      // 有開主體跳出卻一個都沒有：說原因
      else if (!r.pops && r.popStats) base += ` · ${$t('主體跳出 0')}（${!r.popStats.slots ? $t('歌曲沒有 drop / 能量上升') : !r.popStats.subjects ? popWhyText(r.popStats.why) : $t('次數 / 間隔')}）`;
      let text = r.effects ? `${base} · ${$t('{0} 個特效', r.effects)}` : base;
      if (r.rampable) {
        // 沒套上的原因（多的排前面）
        const names: Record<string, string> = { spacing: $t('次數 / 間隔'), kind: $t('沒有適合的種類'), short: $t('素材不夠長'), cut: $t('會跨過原本的剪接點'), motion: $t('動作太小'), ban: $t('避開的範圍') };
        const why = Object.entries(r.speedSkip ?? {}).filter(([, n]) => n).sort((x, y) => y[1]! - x[1]!).map(([k, n]) => `${names[k]} ${n}`);
        text += ` · ${$t('變速 {0}/{1}', r.ramps ?? 0, r.rampable)}${why.length ? `（${why.join($t('、'))}）` : ''}`;
      }
      return done(r.warn ? { ok: false, text: `${text} · ${r.warn}` } : { ok: true, text });
    }
  } catch (e) {
    if (abort?.signal.aborted) return { ...done({ ok: false, text: $t('已取消') }), cancelled: true };
    return done({ ok: false, text: $t('自動剪輯失敗：{0}', e instanceof Error ? e.message : e) });
  } finally {
    stopTick();
    abort = null;
    set({ running: false, label: '', frac: null });
  }
}
