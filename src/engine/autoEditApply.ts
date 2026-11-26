/**
 * 自動剪輯的套用端：時間軸上的音樂 → 分析 → planEdit → 換成秒數 → Proposal（add_items，一步復原）。
 * 計畫本身（拍號）由 autoEdit.ts 產生；這裡只負責拍號 ↔ 時間軸秒數、片段 / 特效方塊的細節。
 */
import { attachedAudioIds, makeClip, makeTextClip, uid, useStore, type AudioClip, type Clip, type ClipFx, type FxItem, type Media } from '../store';
import { beatSource, mediaBeats, type Beat } from './beats';
import { getAudioBuffer } from './audio';
import { analyzeMusic, bandEnvelopes, type Bands, type MusicInfo } from './musicAnalysis';
import { DEFAULT_OPTIONS, planEdit, type EditPlan, type PlanMedia, type PlanOptions, type Recipe, type RuleOpt } from './autoEdit';
import { loadAnalysis, saveAnalysis } from './analysisStore';
import { aeFootage, footage, lastTake, musicClips, useAutoEdit, type AutoEditSettings, type Footage } from './autoEditSettings';
import { $t } from '../i18n';
import { create } from 'zustand';
import { sampleAll, type Sampled } from './mediaSampler';
import { shapeMusic } from './energyShape';
import { expandPop, popFraming, scoreMatte, traceMatte, type PlanPop, type PopLayer } from './subjectPop';
import { DEFAULT_MASK, maskKey, PATH_SHAPE } from './mask';
import { CLIP_MASK_ID } from '../modules/extra';
import { beatTimeF } from './speedRamp';
import { ensureMatte, matteAt, MATTE_SIZE } from './matte';
import type { Keyframe } from './keyframes';
import { directMedia, directorShots } from '../ai/director';
import { countdown } from '../ai/gemini';
import { bestFace, freeRoom, peopleScore } from './mediaAnalysis';
import { confidentLead, findLead, isLead, leadInfo, leadShare } from './faceLead';
import { padBox } from './faceTrack';
import { aiErrorText, toAiError, useAiSettings } from '../ai/assistant';
export { useAutoEdit, type AutoEditSettings };
import { AUDIO_DRIVE, fxGroup, intensityParams, transitionOpt } from './autoEditPools';
import { fxCombo, usePrefs } from '../prefs';
import { newKey } from './keyframes';
import { cropClip, fitSize, intoCrop, outOfCrop, type Crop } from './transform';
import { isHitFx, parseDuration } from './params';
import { snapFrame } from './rulerTicks';
import { applyProposals, type Proposal } from '../ai/projectTools';
import { beginHistoryTransaction, docChanged, endHistoryTransaction, snapshotDoc, type HistoryDoc } from './history';
import { beatLead } from '../ui/beatGrid';
import type { FxTrigger } from './trigger';

type S = ReturnType<typeof useStore.getState>;

export { aeFootage, footage, musicClips, type Footage };

export interface MusicSource {
  audio: AudioClip;
  media: Media;
  /** 片段範圍內的節拍（素材秒數） */
  beats: Beat[];
  /** 第 i 拍在時間軸上的秒數；0 = 片段開頭、beats.length = 片段結尾 */
  time: (i: number) => number;
}

export function musicSource(s: S, audioId: string): MusicSource | null {
  const audio = s.audios.find((a) => a.id === audioId);
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
export async function analyzeSource(src: MusicSource): Promise<MusicInfo> {
  const key = `${src.media.id}:${src.beats[0].t}:${src.beats.length}`;
  const hit = musicCache.get(key) ?? await loadAnalysis<MusicInfo>('music', key);
  if (hit) {
    musicCache.set(key, hit);
    if (useAutoEdit.getState().analysis?.info !== hit) useAutoEdit.getState().set({ analysis: { audioId: src.audio.id, info: hit } });
    return hit;
  }
  const bands = await bandsOf(src.media);
  const info = analyzeMusic(src.beats, src.media.peaks ?? [], src.media.peaksPerSec || 100, bands);
  musicCache.set(key, info);
  void saveAnalysis('music', key, info);
  useAutoEdit.getState().set({ analysis: { audioId: src.audio.id, info } });
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
    // 有主角：從主角的臉開始追（框選目標），不會跟到同框的別人；沒有就一般的臉部追蹤
    // 有裁切：分析結果是框內座標，追蹤用的框要換回整個畫面
    const anchor = sh.anchor && m.crop ? outOfCrop(sh.anchor, m.crop) : sh.anchor;
    if (anchor) c.subject = { kind: 'box', anchors: [{ t: +(anchor.t + (m.kind === 'video' ? m.from ?? 0 : 0)).toFixed(4), box: padBox(anchor) }] };
    else if (sh.face) c.subject = { kind: 'face' };
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
    // 裁切：放大位移成只看得到框內（推近 / 運鏡是對框內畫面做的，一起換算）
    if (m.crop) {
      c.fit = 'cover';
      Object.assign(c, cropClip(c, m.crop, (m.width || 16) / (m.height || 9), s.format.w / s.format.h));
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
  for (const p of plan.pops ?? []) for (const l of expandPop(p, T)) {
    const c = popClip(l, s, p, mediaOf);
    if (c) clips.push(c);
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
      effects.push({ ...fx, ...(trigger ? { trigger } : {}), stack: fx.stack?.map((x) => ({ ...x, id: uid() })), id: uid(), start, duration, track });
      continue;
    }
    const mod = s.modules.find((x) => x.id === o.moduleId);
    if (!mod) continue;
    // 衝擊特效只打一下：方塊長度 = 模組的 @duration（不超過計畫的範圍）
    if (!trigger && isHitFx(mod)) duration = Math.min(duration, parseDuration(mod.code, 0.5));
    if (duration < 1 / 60) continue;
    // 跟著音樂音量動的參數（只聽音樂那一軌）
    const ad = AUDIO_DRIVE[o.moduleId];
    const audio = ad ? { [ad.param]: { source: 'level' as const, min: ad.min, max: ad.max, ...(src.audio ? { from: { audio: [src.audio.track] } } : {}) } } : undefined;
    effects.push({ id: uid(), moduleId: o.moduleId, params: { ...(o.params ?? {}) }, start, duration, track, ...(trigger ? { trigger } : {}), ...(audio ? { audio } : {}) });
  }
  return { clips, effects };
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

/** 圖片能不能做主體跳出（去背後量主體的位置 / 大小）；同一張圖算一次 */
const popCache = new Map<string, { ok: boolean; centered: boolean; cx: number; cy: number; path?: string }>();
async function popInfo(m: Media, s: S, at = 0): Promise<{ ok: boolean; centered: boolean; cx: number; cy: number; path?: string }> {
  const key = m.kind === 'video' ? `${m.id}@${at.toFixed(2)}:${s.format.w}x${s.format.h}` : `${m.id}:${s.format.w}x${s.format.h}`;
  const hit = popCache.get(key);
  if (hit) return hit;
  await ensureMatte(m, [m.kind === 'video' ? at : 0]);
  const d = matteAt(m, m.kind === 'video' ? at : 0);
  const r = d ? popFraming(scoreMatte(d.data, MATTE_SIZE), m.width, m.height, s.format.w, s.format.h) : { ok: false, centered: false, cx: 0, cy: 0, area: 0 };
  // 輪廓路徑（剪影窗 / 主體挖洞用；只有能用的圖才描）
  const path = r.ok && d ? traceMatte(d.data, MATTE_SIZE) : '';
  const out = { ok: r.ok, centered: r.centered, cx: r.cx, cy: r.cy, ...(path ? { path } : {}) };
  popCache.set(key, out);
  return out;
}
/** 影片最多挑幾格去背；每支最多幾格；揭露後至少要能接著播幾秒 */
const POP_MAX_FRAMES = 8;
const POP_PER_VIDEO = 2;
const POP_ROOM = 4;

/**
 * 影片裡適合做主體跳出的幾格（素材時間，相對指定片段的起點）：
 * 有主角 → 主角的臉最大的那幾格；有臉 → 臉最大的；都沒有 → 影片 30% 的地方。同一支挑的格子至少隔 5 秒。
 */
export function popFrameCandidates(media: Footage[], extra: Map<string, Partial<PlanMedia>>): { m: Footage; t: number }[] {
  const out: { m: Footage; t: number; h: number }[] = [];
  for (const m of media) {
    // 有裁切的片段不拿來做主體跳出（去背、對齊都是看整個畫面）
    if (m.kind !== 'video' || m.crop || m.duration < POP_ROOM + 1 || extra.get(m.id)?.weight === 0) continue;
    const x = extra.get(m.id);
    const ok = (t: number) => t <= m.duration - POP_ROOM && !x?.ban?.some(([a, b]) => t >= a - 0.1 && t <= b + POP_ROOM);
    const pts = x?.leadPts?.length ? x.leadPts.map((p) => ({ t: p.t, h: p.h }))
      : (x?.info?.faces ?? []).map((f, i) => (f ? { t: i * x!.info!.step, h: f.h } : null)).filter((p): p is { t: number; h: number } => !!p);
    const list = pts.length ? pts : [{ t: m.duration * 0.3, h: 0 }];
    const picked: { t: number; h: number }[] = [];
    for (const p of [...list].sort((a, b) => b.h - a.h)) {
      if (picked.length >= POP_PER_VIDEO) break;
      if (ok(p.t) && picked.every((q) => Math.abs(q.t - p.t) >= 5)) picked.push(p);
    }
    for (const p of picked) out.push({ m, t: p.t, h: p.h });
  }
  return out.sort((a, b) => b.h - a.h).slice(0, POP_MAX_FRAMES).map(({ m, t }) => ({ m, t }));
}

/** 最多替幾張圖去背（第一次要下載模型、每張要算一下） */
const POP_MAX_IMAGES = 20;

// ───────────── 面板設定 / 執行 ─────────────

/** 設定 → 編排器的選項（只留目前存在的模組 / 組合） */
export function planOptions(st: AutoEditSettings, s: S = useStore.getState()): PlanOptions {
  const tr = s.modules.filter((m) => m.kind === 'transition' && (st.trWeights[m.id] ?? 1) > 0)
    .map((m) => ({ ...transitionOpt(m), weight: st.trWeights[m.id] ?? 1 }));
  const rules: RuleOpt[] = [];
  for (const { on, ...r } of st.rules) {
    const chance = Math.min(1, r.chance * st.density);
    if (!on || chance <= 0) continue;
    const mod = s.modules.find((m) => m.id === r.moduleId && m.kind === 'effect');
    const combo = mod ? undefined : fxCombo(r.moduleId);
    const main = combo && s.modules.find((m) => m.id === combo.fx.moduleId);
    if (!mod && !main) continue; // 模組 / 組合不見了：這層跳過
    rules.push({
      ...r, chance, group: fxGroup((mod ?? main)!), hit: isHitFx((mod ?? main)!),
      ...(mod && intensityParams(mod.id, st.intensity) ? { params: intensityParams(mod.id, st.intensity) } : {}),
    });
  }
  const pops = st.popOn && st.popVariants.length ? { variants: st.popVariants, per32: st.popsPer32, text: st.popText } : undefined;
  const speed = st.speedOn && st.speedVariants.length ? { variants: st.speedVariants, per32: st.speedsPer32, intensity: st.speedIntensity } : undefined;
  return { transitions: tr, accents: [], dropHit: null, rules, kenBurns: st.kenBurns, order: st.order, pops, speed };
}

/** 上一版：產生前 / 產生後的專案（「再一版」= 回到產生前再產生，跟復原紀錄裡後來的面板設定變更無關） */
let last: { before: HistoryDoc; after: HistoryDoc } | null = null;
/** 上一版之後還沒有其他修改（「再一版」會先拿掉上一版） */
export const canReplaceLast = () => !!last && !docChanged(last.after);
lastTake.replaceable = canReplaceLast;

export type AutoEditError = 'noMusic' | 'noMedia' | 'noRange' | 'noKey' | 'empty' | 'cancelled';
/** 進度：音樂 / 素材分析（第幾個、共幾個）/ AI 導演 */
export type AutoEditProgress = { stage: 'music' } | { stage: 'media'; i: number; n: number; name: string; frac: number } | { stage: 'matte'; i: number; n: number; name: string }
  | { stage: 'director'; retry?: { n: number; wait: number; format?: boolean }; files?: number; images?: number; batch?: { done: number; total: number } }
  | { stage: 'directed'; list: { name: string; roles: string[]; weight: number; note: string; use?: [number, number][]; avoid?: [number, number][] }[] }
  | { stage: 'plan' }
  | { stage: 'lead'; files: number; spans: number; skipped: number; unsure?: true };

/** 依目前的設定產生一版並套用（一步復原）；replaceLast：上一版之後沒有其他修改 → 先復原上一版 */
export async function runAutoEdit(replaceLast = false, onProgress: (p: AutoEditProgress) => void = () => {}, signal?: AbortSignal): Promise<{ shots: number; effects: number; pops: number; warn?: string } | { error: AutoEditError }> {
  const st = useAutoEdit.getState();
  let s = useStore.getState();
  const audioId = st.audioId && s.audios.some((a) => a.id === st.audioId) ? st.audioId : musicClips(s)[0]?.id;
  const src0 = audioId ? musicSource(s, audioId) : null;
  if (!audioId || !src0) return { error: 'noMusic' };
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
  // 主角：所有素材裡出現最多的那個人（臉的特徵分群）；夠明顯才用
  const notes = new Map<string, (t: number) => string>();
  if (st.analyze) {
    const all = [...sampled.values()].flatMap((x) => [...(x.info?.facesAt ?? []).flatMap((l) => l ?? []), ...(x.faceList ?? [])])
      .filter((f): f is typeof f & { emb: number[] } => !!f.emb);
    const lead = findLead(all);
    const frames = [...sampled.values()].flatMap((x) => [...(x.info?.facesAt ?? []), ...(x.faceList ? [x.faceList] : [])]);
    if (confidentLead(lead, lead ? leadShare(frames, lead) : 0)) {
      let files = 0, spans = 0, skipped = 0;
      for (const [id, x] of sampled) {
        if (x.info?.facesAt) {
          const r = leadInfo(x.info, x.info.facesAt, lead);
          const pts = r.states.flatMap((s, i) => {
            const b = s === 'lead' ? x.info!.facesAt![i]!.filter((f) => isLead(f, lead)).sort((p, q) => q.h - p.h)[0] : null;
            return b ? [{ t: i * x.info!.step, x: b.x, y: b.y, w: b.w ?? b.h, h: b.h }] : [];
          });
          extra.set(id, { ...extra.get(id), info: { ...x.info, faces: r.faces, people: r.people }, people: r.people.reduce((s, v) => s + v, 0) / Math.max(1, r.people.length), ban: r.ban, leadPts: pts });
          if (pts.length) files++;
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
          const others = !lf && x.faceList.some((f) => f.emb);
          if (lf) files++;
          if (others) skipped++;
          extra.set(id, { ...extra.get(id), face: lf ?? null, people: lf ? Math.min(1, lf.h / 0.25) : 0,
            ...(lf ? { leadPts: [{ t: 0, x: lf.x, y: lf.y, w: lf.w ?? lf.h, h: lf.h }] } : {}), ...(others ? { weight: 0 } : {}) });
          notes.set(id, () => (lf ? ' [main person]' : others ? ' [only other people]' : ''));
        }
      }
      onProgress({ stage: 'lead', files, spans, skipped });
    } else if (all.length) onProgress({ stage: 'lead', files: 0, spans: 0, skipped: 0, unsure: true });
  }
  // 主體跳出：替候選圖片去背、量主體；frames = 影片裡拿來做主體跳出的那幾格（當成另外的素材）
  const frames: Footage[] = [];
  if (st.popOn && st.popVariants.length) {
    const imgs = media.filter((m) => m.kind === 'image').slice(0, POP_MAX_IMAGES);
    for (let i = 0; i < imgs.length; i++) {
      if (stopped()) return { error: 'cancelled' };
      const m = imgs[i];
      if (!popCache.has(`${m.id}:${s.format.w}x${s.format.h}`)) onProgress({ stage: 'matte', i: i + 1, n: imgs.length, name: m.name });
      try {
        extra.set(m.id, { ...extra.get(m.id), pop: await popInfo(m, s) });
      } catch {
        // 去背失敗（模型載入失敗之類）：這張不做主體跳出
      }
    }
    // 影片：挑幾格去背（有主角就挑主角的臉最大的那幾格），主體跳出後揭露那一拍直接從這格接著播
    const cands = popFrameCandidates(media, extra);
    for (let i = 0; i < cands.length; i++) {
      if (stopped()) return { error: 'cancelled' };
      const { m, t } = cands[i];
      const real = s.media.find((x) => x.id === (m.srcId ?? m.id));
      if (!real) continue;
      const at = (m.from ?? 0) + t;
      if (!popCache.has(`${real.id}@${at.toFixed(2)}:${s.format.w}x${s.format.h}`)) onProgress({ stage: 'matte', i: i + 1, n: cands.length, name: `${m.name} @${t.toFixed(1)}s` });
      try {
        const pop = await popInfo(real, s, at);
        if (!pop.ok) continue;
        const id = `${m.id}@${t.toFixed(2)}`;
        frames.push({ ...m, id, srcId: real.id, from: at, duration: m.duration - t });
        extra.set(id, { pop, popOnly: true, ...(extra.get(m.id)?.roles ? { roles: extra.get(m.id)!.roles } : {}) });
      } catch {
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
  const before = snapshotDoc();
  const replace = replaceLast && canReplaceLast() ? last!.before : null;
  beginHistoryTransaction();
  let ok = false;
  let shots = 0, nfx = 0, plannedPops = 0;
  try {
    if (replace) {
      const { aux: _aux, ...proj } = replace;
      useStore.setState(proj);
    }
    s = useStore.getState();
    const src = musicSource(s, audioId);
    if (!src) return { error: 'noMusic' };
    let range: [number, number] | undefined;
    if (st.range === 'loop') {
      const r = s.loop && beatRange(src, s.loop.a, s.loop.b);
      if (!r) return { error: 'noRange' };
      range = r;
    }
    const seed = (Math.random() * 2 ** 31) >>> 0;
    const plan = planFor(src, music, [...media, ...frames], st.params, seed, planOptions(st, s), range, extra);
    const { clips, effects } = planItems(plan, src, s, [...media, ...frames]);
    if (!clips.length) return { error: 'empty' };
    plannedPops = plan.pops?.length ?? 0;
    const p: Proposal = { summary: 'auto edit', op: { op: 'add_items', clips, effects } };
    applyProposals([p]);
    ok = true;
    shots = clips.length;
    nfx = effects.length;
  } finally {
    endHistoryTransaction(ok);
  }
  last = { before: replace ?? before, after: snapshotDoc() };
  return { shots, effects: nfx, pops: plannedPops, ...(warn ? { warn } : {}) };
}

/** 執行狀態（面板的進度條）：label = 現在在做什麼、frac = 0..1（null = 不知道要多久）、result = 上一次的結果 */
export interface AutoEditRun {
  running: boolean;
  label: string;
  frac: number | null;
  result: { ok: boolean; text: string } | null;
  /** 這次做了哪些步驟（AI 分頁顯示用；每一步一行） */
  log: string[];
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
        step(p.unsure ? $t('認不出明顯的主角（臉太少，或好幾個人出現得一樣多）')
          : $t('主角：出現在 {0} 個素材；只有別人的 {1} 段會避開', p.files, p.spans) + (p.skipped ? ` · ${$t('{0} 張圖沒有主角，不用', p.skipped)}` : ''));
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
        noMusic: $t('沒有節拍：先在音訊軌放音樂'), noMedia: $t('沒有可用的素材'), noRange: $t('循環範圍裡沒有節拍'),
        noKey: $t('AI 導演需要 API 金鑰'), empty: $t('沒有產生任何片段'),
      }[r.error];
      return done({ ok: false, text: msg });
    } else {
      const base = r.pops ? $t('已產生 {0} 個鏡頭、{1} 個主體跳出', r.shots, r.pops) : $t('已產生 {0} 個鏡頭', r.shots);
      const text = r.effects ? `${base} · ${$t('{0} 個特效', r.effects)}` : base;
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
