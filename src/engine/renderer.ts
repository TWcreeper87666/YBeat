import { $t } from '../i18n';
import { audioSignal, fromKey, randomSignal, type AudioSignal } from './audioReact';
import { holdScrub, scrubFrameAt } from './scrubCache';
import { previewUrl } from './proxy';
import { ensureReverseFrames, reverseFrameAt } from './reverseCache';
import { fxLevel, makeClip, type AnimItem, type BlendMode, type TransitionRef, type AudioClip, type AudioDrive, type AudioFrom, type Clip, type FxItem, type Media, type Module, type Tracks } from '../store';
import { animBeatAtTime, animBeatLen, animLayers, animMaskAt, animMatrix, animSecAt, animTransformAt, layerMaskAt, layerMaskToScreen, type AnimDrawLayer } from './animation';
import { clipEdit, EDIT_SIZE, editedMatte, editKey, slotEdit, type CutoutEdit } from './cutoutEdit';
import { traceMatte } from './subjectPop';
import { maskAt, type Mask } from './mask';
import { FIELD_RANGE, getShapeField, maskFieldKey, type ShapeField } from './maskShapes';
import { CLIP_MASK_ID } from '../modules/extra';
import { DEFAULT_TEXT, renderText, TEXT_PRESETS, textKey } from './text';
import { fitScale, hexToRgb, isHitFx, isNumeric, paramAt, parseDuration, parseParams, resolveParams, type ParamDef, type ParamValues } from './params';
import { clipSource, plainSpeed } from './remap';
import { MATTE_SIZE, matteAt, requestMatte } from './matte';
import { clipTransformAt, DEFAULT_TRANSFORM } from './transform';
import { cropView, fitSize } from './transform';
import { evalKeys, type Keyframe } from './keyframes';
import { fitOf, followOf, subjectRectInFrame, tracking, withOffset, type Follow, type FollowMap } from './follow';
import { animFrameAt, animImage, animImageReady } from './animImage';
import { chanceWindow, cutPoints, cutTracks, fxWindow, hasChance, hitWindow, scatterPoint, timingIndex, triggerBeats, triggerIndex, triggerWindow, type FxTrigger } from './trigger';

export interface RenderCtx {
  clips: Clip[];
  audios: AudioClip[];
  videoTracks: Clip[][]; // 依軌道分組、依開始時間排序
  effects: FxItem[];
  anims: AnimItem[];
  tracks: Tracks;
  modules: Map<string, Module>;
  media: Map<string, Media>;
  /** 有連結音訊的連結 id（這些影片片段本身不出聲） */
  linked: Set<string>;
}

export type ExportFrameSource = (clip: Clip, media: Media, sourceTime: number) => Promise<VideoFrame | null>;

const animBeatTime = (item: AnimItem) => {
  const beats = triggerBeats(1);
  const i = beats.findIndex((b) => b >= item.start);
  return i >= 0 && i + 1 < beats.length ? beats[i + 1] - beats[i] : item.duration / 4;
};

/** 動畫的文字層（文字在主體後面）：大字描邊，比主體寬，左右才露得出來 */
const ANIM_TEXT = { ...(TEXT_PRESETS.find((p) => p.id === 'outline')?.style ?? {}), size: 380 };

type DrawClip = Clip & { animMatrix?: [number, number, number, number] };
function animClip(item: AnimItem, draw: AnimDrawLayer, media?: Media, frameAspect?: number): DrawClip {
  const s = draw.slot;
  const crop = s.crop && media && frameAspect ? cropView(s.crop, media.width / media.height, frameAspect) : null;
  const secAt = (beat: number) => animSecAt(item, beat);
  const effects = draw.layer.effects?.map((fx) => {
    if (!fx.beatEvery) return fx;
    const hits = [];
    for (let b = draw.layer.fromBeat; b < draw.layer.toBeat; b += fx.beatEvery)
      hits.push({ t: secAt(b), d: Math.min((fx.hitBeats ?? 0.8) * animBeatLen(item), secAt(b + fx.beatEvery) - secAt(b)) });
    return { ...fx, timing: { kind: 'hits' as const, hits } };
  });
  const matrix = draw.matrix;
  const cropX = crop?.x ?? 0, cropY = crop?.y ?? 0;
  const x = matrix && frameAspect ? draw.x + (matrix[0] * cropX * frameAspect + matrix[2] * cropY) / frameAspect : draw.x + cropX * draw.scaleX;
  const y = matrix && frameAspect ? draw.y + matrix[1] * cropX * frameAspect + matrix[3] * cropY : draw.y + cropY * draw.scaleY;
  const clip = makeClip({ id: `anim:${item.id}:${s.id}:${draw.id}`, mediaId: s.mediaId!, track: item.track,
    start: item.start, duration: item.duration, in: s.sourceTime, rate: 0,
    aiMatte: s.cutout?.mode === 'auto', matteEdit: s.cutout?.edit, blend: draw.layer.blend,
    transform: { x, y,
      scaleX: draw.scaleX * (crop?.s ?? 1), scaleY: draw.scaleY * (crop?.s ?? 1), rotation: draw.rotation, opacity: draw.opacity },
    effects, ...(draw.layer.text ? { text: { ...DEFAULT_TEXT, ...ANIM_TEXT, text: draw.layer.text }, fit: 'contain' as const } : {}) });
  return matrix ? Object.assign(clip, { animMatrix: matrix.map((v) => v * (crop?.s ?? 1)) as [number, number, number, number] }) : clip;
}

/** 去背用的遮罩：有手動修正就是修正後的（EDIT_SIZE），沒有 = AI 遮罩；還沒好 = null */
function slotMatte(media: Media, t: number, edit: CutoutEdit | null): { data: Uint8Array; size: number; stamp: string } | null {
  const m = matteAt(media, t);
  if (!m) return null;
  const base = `${media.id}:${m.idx}`;
  if (!edit) return { data: m.data, size: MATTE_SIZE, stamp: base };
  const data = editedMatte({ data: m.data, size: MATTE_SIZE }, edit.fix, (media.width || 1) / (media.height || 1), base);
  return { data, size: EDIT_SIZE, stamp: `${base}:${editKey(edit)}` };
}

export type FrameInfo =
  | { kind: 'empty' }
  | { kind: 'clip'; clip: Clip }
  /** A / B 為 null = 透明（片段開頭前面沒東西、或結尾後面沒東西） */
  | { kind: 'transition'; A: Clip | null; B: Clip | null; tr: TransitionRef; progress: number; d: number };

const ADJ_EPS = 0.01;
/** 播放時提前多少秒開始播放下一段影片 */
const PREROLL = 0.4;
/** 還沒開始的片段：多久之內才建立 <video>（太早建立的話，片段多時幾十個影片同時預載、搶解碼器） */
const CREATE_AHEAD = 4;
/** 整串都播完超過這麼久的 <video>：放掉（解碼器、記憶體）；倒回去時再建立 */
const RELEASE_AFTER = 0.5;

/** false = 直接覆寫；true = 一般疊加；或指定混合模式 */
type Blend = boolean | BlendMode;
export const adjacent = (a: Clip | undefined, b: Clip | undefined) => !!a && !!b && Math.abs(a.start + a.duration - b.start) <= ADJ_EPS;

/**
 * 轉場的時間範圍：
 * - cut：前面有緊貼的片段 → 以剪接點為中心
 * - head：前面沒有片段 → 從透明轉入，放在片段開頭
 * - tail：片段的轉出（後面沒有緊貼的片段）→ 轉到透明，放在片段結尾
 */
export interface TrWindow { t0: number; d: number; mode: 'cut' | 'head' | 'tail'; max: number }
export function transitionWindow(prev: Clip | undefined, c: Clip, side: 'in' | 'out' = 'in', next?: Clip): TrWindow | null {
  if (side === 'out') {
    if (!c.transitionOut || adjacent(c, next)) return null;
    const d = Math.min(c.transitionOut.duration, c.duration);
    return { t0: c.start + c.duration - d, d, mode: 'tail', max: c.duration };
  }
  if (!c.transitionIn) return null;
  if (adjacent(prev, c)) {
    const max = Math.min(prev!.duration, c.duration);
    const d = Math.min(c.transitionIn.duration, max);
    return { t0: c.start - d / 2, d, mode: 'cut', max };
  }
  const d = Math.min(c.transitionIn.duration, c.duration);
  return { t0: c.start, d, mode: 'head', max: c.duration };
}

/** 速度低於這個（含倒播）的那幾格改用倒播快取 */
const REVERSE_RATE = 0.25;
/** 速度高於這個（往前跳）也算：<video> 跟不上，一樣要 seek */
const JUMP_RATE = 16;
/**
 * 變速曲線裡 <video> 跟不上的區段（倒播 / 極慢 / 跳格），片段內秒數。
 * exit = 離開這段時的素材時間（在這段裡就先把 <video> seek 過去等著）。
 * ranges = 要先解好的素材範圍：前後多留一點，離開後 <video> 還沒跟上時接著用快取。
 */
interface CurveSpans { spans: { t0: number; t1: number; exit: number }[]; ranges: [number, number][] }
const spanMemo = new WeakMap<object, CurveSpans & { in: number; dur: number }>();
function curveSpans(clip: Clip, media: Media, ctx: Pick<RenderCtx, 'modules'>): CurveSpans | null {
  const keys = clip.remap.moduleId === 'remap-curve' ? clip.remap.keys : undefined;
  if (!keys?.length || media.kind !== 'video') return null;
  const memoKey = keys as unknown as object;
  const m = spanMemo.get(memoKey);
  // 同一條曲線換了 in / 長度（例如移動素材起點）：重算
  if (m && m.in === clip.in && m.dur === clip.duration) return m.spans.length ? m : null;
  // 跟 clipSource 的差分間隔一樣（1/60 秒）：每一小段都剛好被一個取樣涵蓋，短短的跳格也不會漏
  const step = 1 / 60;
  const n = Math.max(8, Math.ceil(clip.duration / step));
  const at = (k: number) => clipSource(clip, Math.min(clip.duration, k * step), media, ctx.modules);
  const spans: CurveSpans['spans'] = [];
  for (let k = 0; k < n; k++) {
    const { rate } = at(k);
    // 片段最後一格的差分會被夾住變成 0，不算
    if (k * step >= clip.duration - step) break;
    if (rate >= REVERSE_RATE && rate <= JUMP_RATE) continue;
    const last = spans.at(-1);
    if (last && Math.abs(last.t1 - k * step) < 1e-9) last.t1 = (k + 1) * step;
    else spans.push({ t0: k * step, t1: (k + 1) * step, exit: 0 });
  }
  const ranges: [number, number][] = [];
  for (const sp of spans) {
    sp.t1 = Math.min(sp.t1, clip.duration);
    sp.exit = at(Math.round(sp.t1 / step)).src;
    let a = Infinity, b = -Infinity;
    for (let k = Math.floor(Math.max(0, sp.t0 - 0.2) / step); k * step <= Math.min(clip.duration, sp.t1 + 0.6); k++) {
      const { src } = at(k);
      a = Math.min(a, src);
      b = Math.max(b, src);
    }
    const prev = ranges.at(-1);
    if (prev && a <= prev[1] + 0.5 && b >= prev[0] - 0.5) {
      prev[0] = Math.min(prev[0], a);
      prev[1] = Math.max(prev[1], b);
    } else ranges.push([a, b]);
  }
  const out = { spans, ranges, in: clip.in, dur: clip.duration };
  spanMemo.set(memoKey, out);
  return spans.length ? out : null;
}
/** 預覽：現在 ~ 4 秒後會播到的倒播片段，先把影格解好 */
function prefetchReverse(ctx: RenderCtx, t: number) {
  // 近的先排（解碼一次只做兩段）
  for (const c of ctx.videoTracks.flat().sort((x, y) => x.start - y.start)) {
    if (c.start > t + 8 || c.start + c.duration < t) continue;
    const m = ctx.media.get(c.mediaId);
    if (!m || m.missing) continue;
    const cs = curveSpans(c, m, ctx);
    if (cs) for (const [a, b] of cs.ranges) void ensureReverseFrames(m, a, b);
  }
}

export function sortClips(clips: Clip[]) {
  return [...clips].sort((a, b) => a.start - b.start);
}

/** 單一軌道在時間 t 的狀態（clips 需已排序） */
/**
 * 特效軌方塊（調整圖層，level = 它下面有幾條影片軌）跟隨目標時看的片段：
 * track 有指定 → 那條影片軌這一刻的片段；沒有 → 底下由上往下第一個有追蹤的片段。
 */
export function subjectClipUnder(ctx: Pick<RenderCtx, 'videoTracks' | 'tracks'>, level: number, t: number, track?: number): { clip: Clip; local: number } | null {
  const at = (i: number) => {
    if (ctx.tracks.video[i]?.hidden || !ctx.videoTracks[i]) return null;
    const fr = computeFrame(ctx.videoTracks[i], t);
    const c = fr.kind === 'clip' ? fr.clip : fr.kind === 'transition' ? (fr.progress < 0.5 ? fr.A ?? fr.B : fr.B ?? fr.A) : null;
    return c && !c.text && tracking(c) ? { clip: c, local: t - c.start } : null;
  };
  if (track != null) return at(track);
  for (let i = Math.min(level, ctx.videoTracks.length) - 1; i >= 0; i--) {
    const r = at(i);
    if (r) return r;
  }
  return null;
}

export function computeFrame(sorted: Clip[], t: number): FrameInfo {
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const w = transitionWindow(sorted[i - 1], c, 'in');
    if (w && t >= w.t0 && t < w.t0 + w.d) {
      return { kind: 'transition', A: w.mode === 'cut' ? sorted[i - 1] : null, B: c, tr: c.transitionIn!, progress: (t - w.t0) / w.d, d: w.d };
    }
    const o = transitionWindow(undefined, c, 'out', sorted[i + 1]);
    if (o && t >= o.t0 && t < o.t0 + o.d) return { kind: 'transition', A: c, B: null, tr: c.transitionOut!, progress: (t - o.t0) / o.d, d: o.d };
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const c = sorted[i];
    if (t >= c.start && t < c.start + c.duration) return { kind: 'clip', clip: c };
  }
  return { kind: 'empty' };
}

// ───────────────────────── GLSL ─────────────────────────

export const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_local;
uniform float u_duration;
uniform float u_progress;
uniform float u_level;   // 目前音量 0~1（音訊反應）
uniform float u_beat;    // 節拍脈衝：打到拍 = 1，之後衰減
uniform float u_trigger; // 第幾次觸發（0 起算；沒有觸發 = 0）
`;

export const GLSL_LIB = `
#define PI 3.14159265
#define ASPECT (u_resolution.x / u_resolution.y)
float rand(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
float noise1(float x) { float i = floor(x), f = fract(x); return mix(rand(vec2(i, 0.0)), rand(vec2(i + 1.0, 0.0)), smoothstep(0.0, 1.0, f)) * 2.0 - 1.0; }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec2 rotateUV(vec2 uv, float a, vec2 c) { vec2 p = uv - c; p.x *= ASPECT; p = rot(a) * p; p.x /= ASPECT; return p + c; }
vec2 zoomUV(vec2 uv, float z, vec2 c) { return (uv - c) / z + c; }
vec2 mirrorUV(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }
float easeOutExpo(float x) { return x >= 1.0 ? 1.0 : 1.0 - pow(2.0, -10.0 * x); }
float easeInExpo(float x) { return x <= 0.0 ? 0.0 : pow(2.0, 10.0 * x - 10.0); }
float easeInOutCubic(float x) { return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0; }
float easeOutBack(float x) { float c1 = 1.70158, c3 = c1 + 1.0; return 1.0 + c3 * pow(x - 1.0, 3.0) + c1 * pow(x - 1.0, 2.0); }
// curve 參數（cubic-bezier x1, y1, x2, y2）在 x 的值
float curve(vec4 b, float x) {
  if (b.x < 0.0) return b.y; // 「無」：整段都是 b.y
  x = clamp(x, 0.0, 1.0);
  float lo = 0.0, hi = 1.0, t = x;
  for (int i = 0; i < 20; i++) {
    float bx = 3.0 * (1.0 - t) * (1.0 - t) * t * b.x + 3.0 * (1.0 - t) * t * t * b.z + t * t * t;
    if (bx < x) lo = t; else hi = t;
    t = (lo + hi) * 0.5;
  }
  return 3.0 * (1.0 - t) * (1.0 - t) * t * b.y + 3.0 * (1.0 - t) * t * t * b.w + t * t * t;
}
`;

function paramUniforms(defs: ParamDef[]) {
  const t = { float: 'float', int: 'int', bool: 'bool', color: 'vec3', point: 'vec2', curve: 'vec4' } as const;
  return defs.map((d) => `uniform ${t[d.type]} ${d.name};`).join('\n');
}

export function buildEffectFS(code: string, defs: ParamDef[]) {
  return `${HEAD}uniform sampler2D u_tex;
${GLSL_LIB}
vec4 tex(vec2 uv) { return texture(u_tex, uv); }
${paramUniforms(defs)}
#line 1
${code}
void main() { outColor = effect(v_uv); }`;
}

export function buildTransitionFS(code: string, defs: ParamDef[]) {
  return `${HEAD}uniform sampler2D u_from;
uniform sampler2D u_to;
#define progress u_progress
${GLSL_LIB}
vec4 getFrom(vec2 uv) { return texture(u_from, uv); }
vec4 getTo(vec2 uv) { return texture(u_to, uv); }
${paramUniforms(defs)}
#line 1
${code}
void main() { outColor = transition(v_uv); }`;
}

/** 素材 → 畫面：縮放 / 位移 / 旋轉 / 翻轉 / 不透明度 / 填滿模式（輸出 premultiplied alpha） */
const CLIP_FS = `${HEAD}uniform sampler2D u_tex;
uniform float u_srcAspect;
uniform vec4 u_xf;       // x, y, （未用）, rotation(rad)
uniform vec2 u_scl;      // 水平 / 垂直縮放
uniform mat2 u_inv;
uniform float u_opacity;
uniform int u_fit;       // 0 cover, 1 contain, 2 contain + blur bg, 3 原始大小（文字）
uniform vec2 u_native;   // 原始大小（以畫面高度為 1）
uniform float u_flip;
uniform sampler2D u_matte;  // AI 去背遮罩（沒翻轉，第 0 列 = 最上面）
uniform float u_useMatte;
#define ASPECT (u_resolution.x / u_resolution.y)
vec2 fitSize(bool cover) {
  if (u_fit == 3) return u_native;
  float A = ASPECT, S = u_srcAspect;
  bool wide = S > A;
  if (cover) return wide ? vec2(S, 1.0) : vec2(A, A / S);
  return wide ? vec2(A, A / S) : vec2(S, 1.0);
}
void main() {
  vec2 p = vec2(v_uv.x - 0.5, 0.5 - v_uv.y) - u_xf.xy;   // 畫面座標，y 向下
  p.x *= ASPECT;
  float c = cos(u_xf.w), s = sin(u_xf.w);
  vec2 q = u_inv * p;
  vec2 uv = q / fitSize(u_fit == 0) + 0.5;
  if (u_flip > 0.5) uv.x = 1.0 - uv.x;
  vec4 col = vec4(0.0);
  vec2 aa = fwidth(uv) * 0.75;
  vec2 edge = smoothstep(vec2(0.0), aa, uv) * smoothstep(vec2(0.0), aa, 1.0 - uv);
  float inside = edge.x * edge.y;
  if (inside > 0.0) {
    vec4 s = texture(u_tex, vec2(uv.x, 1.0 - uv.y));
    // 文字有透明度（premultiplied）；一般素材當作不透明
    col = (u_fit == 3 ? vec4(s.rgb * s.a, s.a) : vec4(s.rgb, 1.0)) * inside;
    if (u_useMatte > 0.5) {
      // The matte is inferred at 320px. Tighten its soft edge slightly so
      // source-background colors do not form a visible halo at export size.
      vec2 d = 0.5 / vec2(textureSize(u_matte, 0));
      float a = texture(u_matte, uv).r;
      float inner = min(min(texture(u_matte, uv + vec2(d.x, 0.0)).r,
                            texture(u_matte, uv - vec2(d.x, 0.0)).r),
                        min(texture(u_matte, uv + vec2(0.0, d.y)).r,
                            texture(u_matte, uv - vec2(0.0, d.y)).r));
      col *= smoothstep(0.08, 0.92, mix(a, inner, 0.5));
    }
  }
  if (u_fit == 2 && u_useMatte < 0.5) {
    vec2 bu = (v_uv - 0.5) * vec2(ASPECT, 1.0) / fitSize(true) + 0.5;
    vec3 bg = vec3(0.0);
    for (int i = -2; i <= 2; i++)
      for (int j = -2; j <= 2; j++) bg += textureLod(u_tex, bu + vec2(i, j) * 0.012, 6.0).rgb;
    col = col + vec4(bg / 25.0 * 0.6, 1.0) * (1.0 - col.a);
  }
  outColor = col * u_opacity;
}`;

const BLIT_FS = `${HEAD}uniform sampler2D u_tex;
void main() { outColor = texture(u_tex, v_uv); }`;

/** 特效遮罩：mix(原畫面, 特效結果, 遮罩) */
const MASK_FS = `${HEAD}uniform sampler2D u_src;
uniform sampler2D u_fx;
uniform int u_shape;     // 1 矩形, 2 橢圓, 3 形狀貼圖（距離場）
uniform sampler2D u_shapeTex;
uniform vec4 u_box;      // 中心 x, y（0 = 置中，y 向下）, 寬, 高（以畫面寬 / 高為 1）
uniform float u_feather;
uniform float u_rot;
uniform mat2 u_maskInv;
uniform float u_maskMatrix;
uniform float u_invert;
uniform float u_over;    // 1 = u_fx 是半透明的圖層（去背邊緣）：先疊在原畫面上再混，不然邊緣是黑的
#define ASPECT (u_resolution.x / u_resolution.y)
void main() {
  // 換成以畫面高度為單位的座標，才能正確旋轉
  vec2 p = vec2(v_uv.x - 0.5 - u_box.x, 0.5 - v_uv.y - u_box.y);
  p.x *= ASPECT;
  float c = cos(u_rot), s = sin(u_rot);
  p = u_maskMatrix > 0.5 ? u_maskInv * p : vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
  vec2 half_ = max(vec2(1e-4), (u_maskMatrix > 0.5 ? vec2(ASPECT, 1.0) : vec2(u_box.z * ASPECT, u_box.w)) * 0.5);
  float d;   // 到邊界的距離（外面為正，以畫面高度為單位）
  if (u_shape == 2) {
    float k = length(p / half_);
    d = (k - 1.0) * min(half_.x, half_.y);
  } else if (u_shape == 3) {
    // 距離場：以「半寬」為單位；框外再加上到框的距離
    vec2 uv = p / half_;
    vec2 c = clamp(uv, -1.0, 1.0);
    // p 是 y 向下；距離場貼圖第 0 列 = 形狀上緣（上傳時沒有翻轉）→ v 也是往下增加
    float df = (texture(u_shapeTex, vec2(c.x * 0.5 + 0.5, 0.5 + c.y * 0.5)).r - 0.5) * 2.0 * ${FIELD_RANGE.toFixed(1)};
    // 框外一定在形狀外：距離至少是到框的距離（形狀貼著框邊時，框外不會被當成在裡面而拖出一截）
    // 不能用 length(uv - c) > 0 判斷：GPU 上框內也可能是極小的非零值
    bool inBox = all(lessThanEqual(abs(uv), vec2(1.0)));
    d = (inBox ? df : max(df, 0.0) + length(uv - c)) * min(half_.x, half_.y);
  } else {
    vec2 q = abs(p) - half_;
    d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  }
  float f = max(u_feather, 0.0015);
  float m = 1.0 - smoothstep(-f, f, d);
  if (u_invert > 0.5) m = 1.0 - m;
  vec4 base = texture(u_src, v_uv), top = texture(u_fx, v_uv);
  if (u_over > 0.5) top += base * (1.0 - top.a);
  outColor = mix(base, top, m);
}`;

// ───────────────────────── Renderer ─────────────────────────

interface Target { tex: WebGLTexture; fb: WebGLFramebuffer }
interface Prog { prog: WebGLProgram; defs: ParamDef[]; locs: Map<string, WebGLUniformLocation | null> }

export class Renderer {
  /** 實際渲染大小（預覽可能縮小） */
  w: number;
  h: number;
  /** 專案畫面高度（文字的 px 以它為準） */
  frameH: number;
  readonly gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private vs: WebGLShader;
  private targets: Target[];
  private clipProg: Prog;
  private blit: Prog;
  private maskProg: Prog;
  private progs = new Map<string, { code: string; good: Prog | null }>();
  private textures = new Map<string, WebGLTexture>();
  private images = new Map<string, HTMLImageElement>();
  private uploaded = new Set<string>();
  private videos = new Map<string, HTMLVideoElement>();
  onError: (id: string, msg: string | null) => void = () => {};

  constructor(public canvas: HTMLCanvasElement, size = { w: 1080, h: 1920 }) {
    this.w = size.w;
    this.h = size.h;
    this.frameH = size.h;
    canvas.width = this.w;
    canvas.height = this.h;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error($t('此瀏覽器不支援 WebGL2'));
    this.gl = gl;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(this.vs, VS);
    gl.compileShader(this.vs);

    this.targets = [0, 1, 2, 3, 4, 5, 6].map(() => this.makeTarget());
    this.clipProg = this.mustCompile(CLIP_FS);
    this.blit = this.mustCompile(BLIT_FS);
    this.maskProg = this.mustCompile(MASK_FS);
  }

  /** 改變渲染大小（換輸出比例 / 預覽畫質 / 匯出） */
  setSize(w: number, h: number, frameH = h) {
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    this.frameH = frameH;
    if (w === this.w && h === this.h) return;
    const gl = this.gl;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const t of this.targets) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    this.targets = [0, 1, 2, 3, 4, 5, 6].map(() => this.makeTarget());
  }

  sampleColor(x: number, y: number): string | null {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    const gl = this.gl;
    const pixel = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(
      Math.min(this.w - 1, Math.floor(x * this.w)),
      Math.max(0, this.h - 1 - Math.floor(y * this.h)),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel,
    );
    return `#${[pixel[0], pixel[1], pixel[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }

  private makeTarget(): Target {
    const gl = this.gl;
    const tex = this.newTexture(false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb };
  }

  private newTexture(mip: boolean) {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private compile(fsSrc: string): { prog: WebGLProgram | null; error: string | null } {
    const gl = this.gl;
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(fs) || $t('編譯失敗');
      gl.deleteShader(fs);
      return { prog: null, error: error.trim() };
    }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, this.vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(prog) || $t('連結失敗');
      gl.deleteProgram(prog);
      return { prog: null, error: error.trim() };
    }
    return { prog, error: null };
  }

  private mustCompile(fs: string): Prog {
    const r = this.compile(fs);
    if (!r.prog) throw new Error(r.error ?? '');
    return { prog: r.prog, defs: [], locs: new Map() };
  }

  /** 取得模組的 shader；程式碼改變就重新編譯，失敗時沿用上一個可用版本 */
  /** 衝擊特效打一下多長（@duration）；持續特效 = 0 */
  private hitLens = new Map<string, number>();
  private hitLen(m: Module | undefined): number {
    if (!m) return 0;
    let v = this.hitLens.get(m.code);
    if (v === undefined) this.hitLens.set(m.code, (v = isHitFx(m) ? parseDuration(m.code, 0.5) : 0));
    return v;
  }

  private moduleProg(m: Module): Prog | null {
    let e = this.progs.get(m.id);
    if (e && e.code === m.code) return e.good;
    const defs = parseParams(m.code);
    const fs = m.kind === 'transition' ? buildTransitionFS(m.code, defs) : buildEffectFS(m.code, defs);
    const r = this.compile(fs);
    if (r.prog) {
      if (e?.good) this.gl.deleteProgram(e.good.prog);
      e = { code: m.code, good: { prog: r.prog, defs, locs: new Map() } };
      this.onError(m.id, null);
    } else {
      e = { code: m.code, good: e?.good ?? null };
      this.onError(m.id, r.error);
    }
    this.progs.set(m.id, e);
    return e.good;
  }

  private loc(p: Prog, name: string) {
    if (!p.locs.has(name)) p.locs.set(name, this.gl.getUniformLocation(p.prog, name));
    return p.locs.get(name)!;
  }

  /** 疊加方式（輸入都是 premultiplied alpha；alpha 一律用一般疊加） */
  private setBlend(mode: BlendMode) {
    const gl = this.gl;
    const eq = mode === 'subtract' ? gl.FUNC_REVERSE_SUBTRACT : mode === 'lighten' ? gl.MAX : gl.FUNC_ADD;
    gl.blendEquationSeparate(eq, gl.FUNC_ADD);
    const [src, dst] =
      mode === 'add' || mode === 'subtract' ? [gl.ONE, gl.ONE]
      : mode === 'screen' ? [gl.ONE, gl.ONE_MINUS_SRC_COLOR]
      : mode === 'multiply' ? [gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA]
      : [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    gl.blendFuncSeparate(src, dst, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private pass(target: Target | null, p: Prog, setup: (p: Prog) => void, blend: Blend = false) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(p.prog);
    gl.uniform2f(this.loc(p, 'u_resolution'), this.w, this.h);
    setup(p);
    if (blend) {
      gl.enable(gl.BLEND);
      this.setBlend(blend === true ? 'normal' : blend);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (blend) {
      gl.blendEquation(gl.FUNC_ADD);
      gl.disable(gl.BLEND);
    }
  }

  private bindTex(p: Prog, name: string, tex: WebGLTexture, unit: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.loc(p, name), unit);
  }

  private setCommon(p: Prog, time: number, local: number, duration: number, progress: number) {
    const gl = this.gl;
    gl.uniform1f(this.loc(p, 'u_time'), time);
    gl.uniform1f(this.loc(p, 'u_local'), local);
    gl.uniform1f(this.loc(p, 'u_duration'), duration);
    gl.uniform1f(this.loc(p, 'u_progress'), Math.min(1, Math.max(0, progress)));
    gl.uniform1f(this.loc(p, 'u_level'), this.sig.level);
    gl.uniform1f(this.loc(p, 'u_beat'), this.sig.beat);
    gl.uniform1f(this.loc(p, 'u_trigger'), this.trig);
  }

  /** 目前套用中的特效是第幾次觸發（setCommon 用；套完要歸零） */
  private trig = 0;

  /** 這一格的音訊訊號（render 開頭算一次） */
  private sig: AudioSignal = { level: 0, beat: 0 };
  /** 只聽部分軌道的音訊反應（這一格裡同樣的來源只算一次） */
  private sigFrom = new Map<string, AudioSignal>();
  private sigAt: { ctx: RenderCtx; t: number } | null = null;
  private signalOf(from: AudioFrom | undefined): AudioSignal {
    const k = fromKey(from);
    if (!k || !this.sigAt) return this.sig;
    let v = this.sigFrom.get(k);
    if (!v) this.sigFrom.set(k, (v = audioSignal(this.sigAt.ctx, this.sigAt.t, from)));
    return v;
  }

  private setParams(p: Prog, values: ParamValues, keys?: Record<string, Keyframe[]>, local = 0, drive?: Record<string, AudioDrive>, pts?: Record<string, number[]>) {
    const gl = this.gl;
    const v = resolveParams(p.defs, values);
    // 這一格的值：追蹤 > 音訊反應 > 關鍵影格 / 設定值
    const valueOf = (d: ParamDef) => {
      const dr = drive?.[d.name];
      if (dr && isNumeric(d)) {
        if (dr.source === 'random') return dr.min + (dr.max - dr.min) * randomSignal(dr.seed ?? 0, local, dr.rate);
        const sg = this.signalOf(dr.from);
        return dr.min + (dr.max - dr.min) * (dr.source === 'beat' ? sg.beat : sg.level);
      }
      return paramAt(d, v, keys, local);
    };
    for (const d of p.defs) {
      const l = this.loc(p, d.name);
      if (!l) continue;
      const x = pts?.[d.name] ?? valueOf(d);
      if (d.type === 'float') gl.uniform1f(l, Number(x));
      else if (d.type === 'int') gl.uniform1i(l, Math.round(Number(x)));
      else if (d.type === 'bool') gl.uniform1i(l, x ? 1 : 0);
      // point：存的是畫面座標（y 向下），shader 裡是 uv（y 向上）；範圍（@fit）是寬、高，不翻
      else if (d.type === 'point' && d.fit) {
        // 倍率參數（例如「大小」）不一定在 shader 裡用到，音訊反應要在這裡套
        const k = fitScale(d, p.defs, v, keys, local, (s) => Number(valueOf(s)));
        gl.uniform2f(l, (x as number[])[0] * k, (x as number[])[1] * k);
      } else if (d.type === 'point') gl.uniform2f(l, (x as number[])[0], 1 - (x as number[])[1]);
      else if (d.type === 'curve') gl.uniform4f(l, ...(x as [number, number, number, number]));
      else gl.uniform3f(l, ...hexToRgb(String(x)));
    }
  }

  /**
   * 跟著目標的 point 參數：這一格的位置（畫面座標 + 偏移）。pick = 要看哪個片段的目標（轉場依 side 選前 / 後一段）。
   * 沒有目標 / 還沒算好的參數不會出現在結果裡（照原本的值）。
   */
  private followed(g: Prog, map: FollowMap | undefined, pick: (f: Follow) => { clip: Clip; local: number } | null | undefined, ctx: RenderCtx) {
    let out: Record<string, number[]> | undefined;
    for (const d of g.defs) {
      const f = followOf(d, map);
      if (!f) continue;
      const s = pick(f);
      if (!s) continue;
      const r = subjectRectInFrame(s.clip, ctx.media.get(s.clip.mediaId), s.local, ctx.modules, this.w / this.h);
      if (!r) continue;
      (out ??= {})[d.name] = withOffset(r.c, f);
      // 跟著這個點的範圍參數（@fit）= 目標大小（倍率在 setParams 乘）
      for (const z of g.defs) if (z.fit?.of === d.name && fitOf(z, g.defs, map)) out[z.name] = [...r.s];
    }
    return out;
  }

  /** 觸發的隨機位置：「中心」類的參數（@follow 的 point）換成第 n 次觸發的隨機點（蓋過追蹤） */
  private scattered(g: Prog, tr: FxTrigger | undefined, n: number, base: Record<string, number[]> | undefined) {
    if (tr?.scatter === undefined) return base;
    let out = base;
    const p = scatterPoint(tr.seed ?? 0, n, tr.scatter);
    for (const d of g.defs) if (d.type === 'point' && d.follow && !d.fit) (out = { ...out })[d.name] = p;
    return out;
  }

  private clear(target: Target, opaque: boolean) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.clearColor(0, 0, 0, opaque ? 1 : 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private upload(key: string, source: TexImageSource, mip = true) {
    const gl = this.gl;
    let tex = this.textures.get(key);
    if (!tex) {
      tex = this.newTexture(mip);
      this.textures.set(key, tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    return tex;
  }

  private image(media: Media) {
    let img = this.images.get(media.id);
    if (!img || img.src !== media.url) {
      img = new Image();
      img.src = media.url;
      this.images.set(media.id, img);
      this.uploaded.delete('img:' + media.id);
    }
    return img;
  }

  /** 動態圖片目前上傳到貼圖的是第幾格（同一個素材共用一張貼圖：畫之前才換成這個片段要的那一格） */
  private animShown = new Map<string, number>();
  private animCanvas: OffscreenCanvas | null = null;

  /** 圖片的貼圖；動態圖片（GIF…）依片段內時間 local 換格、循環播放 */
  private imageTex(media: Media, local = 0): WebGLTexture | null {
    const a = animImage(media);
    if (a) {
      const key = 'anim:' + media.id;
      const { index, image } = animFrameAt(a, local);
      if (this.animShown.get(key) !== index || !this.textures.has(key)) {
        // WebGL 上傳 ImageBitmap 時不理 UNPACK_FLIP_Y（會上下顛倒）：先畫到 canvas 再上傳，跟一般圖片一樣翻
        const c = (this.animCanvas ??= new OffscreenCanvas(1, 1));
        if (c.width !== image.width || c.height !== image.height) {
          c.width = image.width;
          c.height = image.height;
        }
        const g = c.getContext('2d')!;
        g.clearRect(0, 0, c.width, c.height);
        g.drawImage(image, 0, 0);
        this.upload(key, c);
        this.animShown.set(key, index);
      }
      return this.textures.get(key)!;
    }
    const key = 'img:' + media.id;
    const img = this.image(media);
    if (this.uploaded.has(key)) return this.textures.get(key)!;
    if (!img.complete || !img.naturalWidth) return null;
    this.upload(key, img);
    this.uploaded.add(key);
    return this.textures.get(key)!;
  }

  /**
   * 切開後首尾相接、內容連續的片段（同一素材、同軌、速度相同、中間沒有轉場）共用同一個 <video>：
   * 播到剪接點時影片元素一路播下去，不用換另一個解碼器接手（換手會頓一下）。
   * 回傳每個片段所屬串接的第一個片段 id。
   */
  private chain = { clips: null as Clip[] | null, root: new Map<string, string>() };
  private rootOf(id: string) {
    return this.chain.root.get(id) ?? id;
  }
  private updateChains(ctx: RenderCtx) {
    if (this.chain.clips === ctx.clips) return;
    const root = new Map<string, string>();
    const byTrack = new Map<number, Clip[]>();
    for (const c of ctx.clips) {
      if (!c.mediaId || c.text) continue;
      if (!byTrack.has(c.track)) byTrack.set(c.track, []);
      byTrack.get(c.track)!.push(c);
    }
    for (const list of byTrack.values()) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i];
        if (a.mediaId !== b.mediaId || a.transitionOut || b.transitionIn) continue;
        if (Math.abs(a.start + a.duration - b.start) > 1e-3) continue;
        const sa = plainSpeed(a, ctx.modules), sb = plainSpeed(b, ctx.modules);
        if (sa === null || sb === null || Math.abs(sa - sb) > 1e-6) continue;
        if (Math.abs(a.in + a.duration * sa - b.in) > 0.05) continue;
        root.set(b.id, root.get(a.id) ?? a.id);
      }
    }
    /**
     * 不同軌上「同一個影片、同一時間播的是同一個位置」的片段（例如下面原片、上面 AI 去背的複本）也共用：
     * 各自一個 <video> 的話，播放時兩個解碼器會差 1～2 格，上下疊起來就對不上（看起來像遮罩慢半拍）。
     */
    const find = (id: string) => {
      let r = id;
      while (root.has(r)) r = root.get(r)!;
      return r;
    };
    const byMedia = new Map<string, { c: Clip; sp: number; off: number }[]>();
    for (const c of ctx.clips) {
      if (!c.mediaId || c.text || ctx.media.get(c.mediaId)?.kind !== 'video') continue;
      const sp = plainSpeed(c, ctx.modules);
      if (sp === null || sp <= 0) continue;
      // 素材時間 = off + 時間軸時間 × sp
      const off = c.in - c.start * sp;
      if (!byMedia.has(c.mediaId)) byMedia.set(c.mediaId, []);
      byMedia.get(c.mediaId)!.push({ c, sp, off });
    }
    for (const list of byMedia.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (a.c.track === b.c.track) continue;
          if (Math.abs(a.sp - b.sp) > 1e-6 || Math.abs(a.off - b.off) > 1e-3) continue;
          const overlap = Math.min(a.c.start + a.c.duration, b.c.start + b.c.duration) - Math.max(a.c.start, b.c.start);
          if (overlap <= 0) continue;
          const ra = find(a.c.id), rb = find(b.c.id);
          if (ra !== rb) root.set(rb, ra);
        }
      }
    }
    // 壓平：每個片段直接指到最終的代表
    for (const id of [...root.keys()]) root.set(id, find(id));
    this.chain = { clips: ctx.clips, root };
  }

  /** preview = 預覽：有代理檔就用代理檔（跳轉快）；匯出一律用原檔 */
  private videoFor(clip: Clip, media: Media, preview: boolean) {
    const key = this.rootOf(clip.id);
    let v = this.videos.get(key);
    const url = preview ? previewUrl(media) : media.url;
    if (!v || v.dataset.src !== url) {
      v?.pause();
      v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = url;
      v.dataset.src = url;
      const vv = v as HTMLVideoElement & { _dirty?: boolean; _mt?: number };
      vv._dirty = true;
      if ('requestVideoFrameCallback' in v) {
        /**
         * 新影格出來時，直接在這個 callback 裡上傳貼圖：只有在這裡，上傳到的那格才保證是 meta 說的那格。
         * 等到下一次畫面迴圈再上傳的話，解碼器可能已經換到下一格，貼圖會比記下的時間超前一格
         * （AI 去背的遮罩看起來就慢一格）。
         */
        const texKey = 'vid:' + key;
        const mark = (_: number, meta: VideoFrameCallbackMetadata) => {
          vv._mt = meta.mediaTime;
          if (this.videos.get(key) !== v) return; // 已經換成別的 <video>
          if (this.textures.has(texKey) && v!.readyState >= 2) {
            this.upload(texKey, v!, this.mipState.get(texKey) ?? false);
            this.texTime.set(texKey, meta.mediaTime);
            vv._dirty = false;
          } else vv._dirty = true;
          vv.requestVideoFrameCallback(mark);
        };
        vv.requestVideoFrameCallback(mark);
      }
      // 暫停時 seek（拖播放頭）不一定會觸發 rVFC：seek 完成 / 資料載入時也標記要重新上傳
      const dirty = () => (vv._dirty = true);
      v.addEventListener('seeked', dirty);
      v.addEventListener('loadeddata', dirty);
      v.addEventListener('canplay', dirty);
      this.videos.set(key, v);
    }
    return v;
  }

  /** 影片貼圖：只有新影格才重新上傳（rVFC 標記）；匯出時一律上傳 */
  private videoTex(clipId: string, v: HTMLVideoElement, mip: boolean, force: boolean, playing = false): WebGLTexture | null {
    const key = 'vid:' + clipId;
    const vv = v as HTMLVideoElement & { _dirty?: boolean; _mt?: number };
    const has = this.textures.get(key);
    const hasRvfc = 'requestVideoFrameCallback' in v;
    // seek 中：currentTime 已經是新的時間，畫面卻還是舊的那格 → 這時上傳會把舊畫面記成新時間（遮罩就對不上）。
    // 先沿用上一張貼圖與它的時間，seek 完成後（seeked / rVFC）再更新
    if (v.seeking && has && !force) return has;
    if (v.readyState >= 2 && (force || !has || !hasRvfc || vv._dirty || this.mipState.get(key) !== mip)) {
      vv._dirty = false;
      this.mipState.set(key, mip);
      // 貼圖裡是哪一格：播放中用 rVFC 給的那格時間；暫停 / 匯出時 seek 到哪就是哪
      this.texTime.set(key, playing && !v.paused && vv._mt !== undefined ? vv._mt : v.currentTime);
      return this.upload(key, v, mip);
    }
    return has ?? null;
  }
  private mipState = new Map<string, boolean>();
  /** 影片貼圖目前是素材的第幾秒 */
  private texTime = new Map<string, number>();
  private bitmaps = new Map<string, ImageBitmap>();
  /** 拖播放頭時的快取影格貼圖 */
  /** 每個片段最後畫的快取影格（拖播放頭時接不上就沿用） */
  private lastScrub = new Map<string, { bm: ImageBitmap; t: number }>();
  private bitmapTex(key: string, bm: ImageBitmap) {
    if (this.bitmaps.get(key) === bm) return this.textures.get(key)!;
    this.bitmaps.set(key, bm);
    return this.upload(key, bm, false);
  }

  /** 預覽用：能用原生播放就用（順暢、可帶原音），倒放 / 極端速度改用逐幀 seek。回傳是否為原生播放 */
  private syncVideo(v: HTMLVideoElement, src: number, rate: number, playing: boolean) {
    if (playing && rate >= 0.0625 && rate <= 16) {
      if (v.paused) {
        if (Math.abs(v.currentTime - src) > 0.04) v.currentTime = src;
        v.playbackRate = rate;
        v.play().catch(() => {});
      } else {
        // 影片落後 → 稍微加速、超前 → 稍微減速；差太多才硬 seek
        const drift = src - v.currentTime;
        if (Math.abs(drift) > 0.75 && !v.seeking) v.currentTime = src;
        const adj = Math.min(16, Math.max(0.0625, rate * (1 + Math.max(-0.4, Math.min(0.4, drift * 1.2)))));
        if (Math.abs(v.playbackRate - adj) > 0.015) v.playbackRate = adj;
      }
      return true;
    }
    if (!v.paused) v.pause();
    if (!v.seeking && Math.abs(v.currentTime - src) > 0.008) v.currentTime = src;
    return false;
  }

  /** 文字片段的貼圖（內容改了才重新上傳） */
  private textTex(clip: Clip): { tex: WebGLTexture; w: number; h: number } {
    const key = 'txt:' + clip.id;
    const k = textKey(clip.text!);
    const c = renderText(clip.text!);
    let tex = this.textures.get(key);
    if (!tex || this.textState.get(key) !== k) {
      tex = this.upload(key, c, true);
      this.textState.set(key, k);
    }
    return { tex, w: c.width, h: c.height };
  }
  private textState = new Map<string, string>();

  /** 把片段畫到 target；blend=true 時疊在現有內容上 */
  private drawClip(target: Target, clip: Clip, t: number, ctx: RenderCtx, mode: 'preview' | 'export', playing: boolean, blend: Blend) {
    const local = t - clip.start;
    // 不在作用範圍裡的特效整個跳過（不跑 shader）
    const wins = new Map<string, { t0: number; d: number }>();
    const on = (clip.effects ?? []).filter((f) => {
      if (f.enabled === false) return false;
      const w = fxWindow(f.timing, local, clip.duration, clip.start);
      if (w) wins.set(f.id, w);
      return !!w;
    });
    // 片段本身的遮罩一律最後套用（切出片段的形狀）
    const fxs = [...on.filter((f) => !f.base), ...on.filter((f) => f.base)];
    const progs = fxs.map((f) => {
      const m = ctx.modules.get(f.moduleId);
      return m && m.kind === 'effect' ? this.moduleProg(m) : null;
    });
    if (!progs.some(Boolean)) return this.drawClipRaw(target, clip, t, ctx, mode, playing, blend);
    // 片段特效：片段自己畫在透明圖層上，依序套特效，最後才疊回去（只影響這個片段）
    const [, , , , CA, CB, CM] = this.targets;
    this.clear(CA, false);
    this.drawClipRaw(CA, clip, t, ctx, mode, playing, false);
    let cur = CA;
    fxs.forEach((f, i) => {
      const g = progs[i];
      if (!g) return;
      const out = cur === CA ? CB : CA;
      // 特效內時間從這次播放開始算；參數 / 遮罩的關鍵影格仍然用片段內時間
      const w = wins.get(f.id)!;
      this.trig = timingIndex(f.timing, w.t0, clip.start);
      this.runEffect(cur, out, CM, f, g, t, local - w.t0, w.d, local, this.followed(g, f.follow, () => ({ clip, local }), ctx));
      this.trig = 0;
      cur = out;
    });
    this.pass(target, this.blit, (p) => this.bindTex(p, 'u_tex', cur.tex, 0), blend);
  }

  private drawClipRaw(target: Target, clip: Clip, t: number, ctx: RenderCtx, mode: 'preview' | 'export', playing: boolean, blend: Blend) {
    const local = t - clip.start;
    if (clip.text) {
      const { tex, w, h } = this.textTex(clip);
      return this.drawTex(target, clip, local, tex, { width: w, height: h } as Media, blend, [w / this.frameH, h / this.frameH]);
    }
    const media = ctx.media.get(clip.mediaId);
    let tex: WebGLTexture | null = null;
    if (!media || media.missing) {
      // 素材遺失：畫警示圖樣，保留片段的位置與變換
      const fake = { ...(media ?? { width: 1080, height: 1920 }), width: media?.width || 1080, height: media?.height || 1920 } as Media;
      return this.drawTex(target, clip, local, this.missingTex(), fake, blend);
    }
    let matteSrc = 0;
    // 動態圖片：遮罩也照片段內時間找那一格
    if (media.kind === 'image') { tex = this.imageTex(media, local); matteSrc = local; }
    else if (media?.kind === 'video') {
      const { src, rate } = clipSource(clip, local, media, ctx.modules);
      matteSrc = src;
      const exportFrame = mode === 'export' ? this.exportFrames.get(clip.id) : undefined;
      if (exportFrame) {
        const key = 'export:' + clip.id;
        tex = this.exportUploaded.has(key) ? this.textures.get(key)! : this.upload(key, exportFrame.frame, clip.fit === 'blur');
        this.exportUploaded.add(key);
        this.drawTex(target, clip, local, tex, media, blend, undefined,
          clip.aiMatte ? this.matteTex(clip, media, exportFrame.pts, ctx) : null);
        return;
      }
      const v = this.videoFor(clip, media, mode === 'preview');
      // 變速曲線的倒播 / 極慢 / 跳格段：用預先解好的影格（<video> 往回 seek 太慢），<video> 先 seek 到這段結束的位置等著
      const cs = mode === 'preview' ? curveSpans(clip, media, ctx) : null;
      const inSpan = cs?.spans.find((s) => local >= s.t0 && local < s.t1);
      if (inSpan) {
        const rf = reverseFrameAt(media, src);
        if (rf) {
          if (!v.paused) v.pause();
          if (!v.seeking && Math.abs(v.currentTime - inSpan.exit) > 0.02) v.currentTime = inSpan.exit;
          this.drawTex(target, clip, local, this.bitmapTex('rev:' + clip.id, rf.bm), media, blend, undefined, clip.aiMatte ? this.matteTex(clip, media, rf.pts, ctx) : null);
          return;
        }
      }
      if (mode === 'preview') {
        this.syncVideo(v, src, rate, playing);
        v.muted = true; // 聲音一律由 audio.ts（Web Audio）播放
      }
      tex = this.videoTex(this.rootOf(clip.id), v, clip.fit === 'blur', mode === 'export', mode === 'preview' && playing);
      // AI 去背的遮罩要對準「貼圖裡實際的那一格」，不是目標時間（播放中影片會稍微超前 / 落後）
      matteSrc = this.texTime.get('vid:' + this.rootOf(clip.id)) ?? src;
      // 剛離開倒播段：<video> 的畫面還沒跟上（seek / 開始播放中）→ 接著用快取影格，不要閃一下舊畫面
      if (cs) {
        const shown = this.texTime.get('vid:' + this.rootOf(clip.id));
        if (v.seeking || shown === undefined || Math.abs(shown - src) > 0.1) {
          const rf = reverseFrameAt(media, src);
          if (rf) {
            this.drawTex(target, clip, local, this.bitmapTex('rev:' + clip.id, rf.bm), media, blend, undefined, clip.aiMatte ? this.matteTex(clip, media, rf.pts, ctx) : null);
            return;
          }
        }
      }
      // 暫停中拖播放頭：精準的 seek 還沒完成（長 GOP 影片很慢）就先用快取的小張影格；
      // 播放中影片還沒載入 / 還沒跟上（差很多）也一樣，不要整格黑掉
      if (mode === 'preview') {
        const shown = this.texTime.get('vid:' + this.rootOf(clip.id));
        if (shown === undefined || Math.abs(shown - src) > (playing ? 0.5 : 0.1)) {
          let sf = scrubFrameAt(media, src);
          // 附近還沒抽好：上一張快取影格如果比 <video> 目前的畫面更接近，就先沿用（不要閃回 seek 前的舊畫面）
          const prev = this.lastScrub.get(clip.id);
          if (!sf && prev && (shown === undefined || Math.abs(prev.t - src) < Math.abs(shown - src))) sf = prev;
          if (sf) {
            this.lastScrub.set(clip.id, sf);
            tex = this.bitmapTex('scrub:' + clip.id, sf.bm);
            // 快取影格不一定剛好在 src（間隔至少 0.25 秒）：遮罩要用這張影格自己的時間，才會跟畫面對上
            matteSrc = sf.t;
          }
        }
      }
    }
    if (!tex) return;
    this.drawTex(target, clip, local, tex, media, blend, undefined, clip.aiMatte ? this.matteTex(clip, media, matteSrc, ctx) : null);
  }

  private matteIdx = new Map<string, string>();
  /** AI 去背遮罩貼圖：遮罩還沒算好就先排進背景計算，這一格照原樣畫 */
  private matteTex(clip: Clip, media: Media, src: number, ctx: RenderCtx): WebGLTexture | null {
    if (media.kind !== 'video' && media.kind !== 'image') return null;
    const m = slotMatte(media, src, clipEdit(clip));
    if (!m) {
      requestMatte(clip, media, ctx.modules);
      return null;
    }
    const gl = this.gl;
    const key = 'matte:' + clip.id;
    const stamp = m.stamp;
    let tex = this.textures.get(key);
    if (tex && this.matteIdx.get(key) === stamp) return tex;
    if (!tex) {
      tex = this.newTexture(false);
      this.textures.set(key, tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, m.size, m.size, 0, gl.RED, gl.UNSIGNED_BYTE, m.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    this.matteIdx.set(key, stamp);
    return tex;
  }

  private missing: WebGLTexture | null = null;
  /** 素材遺失時的警示圖樣（紅色斜紋 + 文字） */
  private missingTex() {
    if (this.missing) return this.missing;
    const c = document.createElement('canvas');
    c.width = 540;
    c.height = 960;
    const g = c.getContext('2d')!;
    g.fillStyle = '#2a0f14';
    g.fillRect(0, 0, 540, 960);
    g.strokeStyle = '#ff3d6e55';
    g.lineWidth = 26;
    for (let i = -1000; i < 1600; i += 70) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i - 960, 960);
      g.stroke();
    }
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.font = '700 54px system-ui, sans-serif';
    g.fillText($t('素材遺失'), 270, 460);
    g.font = '28px system-ui, sans-serif';
    g.fillText($t('把素材拖到時間軸上的片段即可重新連結'), 270, 520);
    this.missing = this.upload('missing', c);
    return this.missing;
  }

  private drawTex(target: Target, clip: Clip, local: number, tex: WebGLTexture, media: Media, blend: Blend, native?: [number, number], matte?: WebGLTexture | null) {
    const xf = clipTransformAt(clip, Math.min(local, clip.duration));
    const fit = native ? 3 : clip.fit === 'cover' ? 0 : clip.fit === 'contain' ? 1 : 2;
    this.pass(
      target,
      this.clipProg,
      (p) => {
        const gl = this.gl;
        this.bindTex(p, 'u_tex', tex, 0);
        gl.uniform1f(this.loc(p, 'u_srcAspect'), media.width / media.height);
        gl.uniform4f(this.loc(p, 'u_xf'), xf.x, xf.y, 1, (xf.rotation * Math.PI) / 180);
        // 負的縮放 = 翻轉；保留正負號，只避免除以 0
        const nz = (v: number) => (v < 0 ? -1 : 1) * Math.max(0.001, Math.abs(v));
        gl.uniform2f(this.loc(p, 'u_scl'), nz(xf.scaleX), nz(xf.scaleY));
        const m = (clip as DrawClip).animMatrix;
        const det = m ? m[0] * m[3] - m[2] * m[1] : 0;
        const inv = m && Math.abs(det) > 1e-8
          ? [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det]
          : [Math.cos(xf.rotation * Math.PI / 180) / nz(xf.scaleX), -Math.sin(xf.rotation * Math.PI / 180) / nz(xf.scaleY),
            Math.sin(xf.rotation * Math.PI / 180) / nz(xf.scaleX), Math.cos(xf.rotation * Math.PI / 180) / nz(xf.scaleY)];
        gl.uniformMatrix2fv(this.loc(p, 'u_inv'), false, inv);
        gl.uniform1f(this.loc(p, 'u_opacity'), Math.min(1, Math.max(0, xf.opacity)));
        gl.uniform1i(this.loc(p, 'u_fit'), fit);
        gl.uniform2f(this.loc(p, 'u_native'), native?.[0] ?? 1, native?.[1] ?? 1);
        gl.uniform1f(this.loc(p, 'u_flip'), clip.flipX ? 1 : 0);
        // 沒有遮罩也要綁：sampler 會留著上一次的單元，那裡可能是這次要畫進去的畫面（回饋迴圈 → 整格畫不出來、變黑）
        this.bindTex(p, 'u_matte', matte ?? tex, 1);
        gl.uniform1f(this.loc(p, 'u_useMatte'), matte ? 1 : 0);
      },
      blend,
    );
  }

  private sample: WebGLTexture | null = null;
  /** 轉場預覽的「下一段」示範畫面 */
  private sampleTex() {
    if (this.sample) return this.sample;
    const c = document.createElement('canvas');
    c.width = 540;
    c.height = 960;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 540, 960);
    grad.addColorStop(0, '#29d3c2');
    grad.addColorStop(1, '#3a0ca3');
    g.fillStyle = grad;
    g.fillRect(0, 0, 540, 960);
    g.globalAlpha = 0.15;
    g.fillStyle = '#fff';
    for (let i = 0; i < 12; i++) g.fillRect(0, i * 80, 540, 30);
    g.globalAlpha = 1;
    g.textAlign = 'center';
    g.font = '900 220px system-ui, sans-serif';
    g.fillText('B', 270, 540);
    g.font = '600 30px system-ui, sans-serif';
    g.fillText($t('下一段（示意）'), 270, 620);
    this.sample = this.upload('sample', c);
    return this.sample;
  }

  /** 預先編譯尚未編譯的特效 / 轉場（一次一個），避免第一次出現時卡頓 */
  warmup(modules: Map<string, Module>) {
    for (const m of modules.values()) {
      if (m.kind === 'remap') continue;
      const e = this.progs.get(m.id);
      if (e && e.code === m.code) continue;
      const g = this.moduleProg(m);
      if (g) {
        // 用 1×1 畫一次，強迫驅動程式真的完成編譯
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[1].fb);
        gl.viewport(0, 0, 1, 1);
        // 貼圖單元可能還綁著這個畫面：先清掉，免得回饋迴圈
        for (let i = 0; i < 4; i++) {
          gl.activeTexture(gl.TEXTURE0 + i);
          gl.bindTexture(gl.TEXTURE_2D, null);
        }
        gl.useProgram(g.prog);
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      return true;
    }
    return false;
  }

  /** 套用一個特效（有遮罩時只作用在遮罩範圍），回傳新的目前畫面 */
  private applyFx(cur: Target, fx: Parameters<Renderer['runEffect']>[3], g: Prog, t: number, local: number, duration: number, pts?: Record<string, number[]>): Target {
    const [TA, , P0, P1] = this.targets;
    const out = cur === P0 ? P1 : P0;
    this.runEffect(cur, out, TA, fx, g, t, local, duration, local, pts);
    return out;
  }

  /** src → out 套一個特效；有遮罩時先畫到 tmp 再依遮罩混合 */
  private runEffect(
    src: Target,
    out: Target,
    tmp: Target,
    fx: { moduleId?: string; params: ParamValues; keys?: Record<string, Keyframe[]>; mask?: Mask; audio?: Record<string, AudioDrive>; follow?: FollowMap },
    g: Prog,
    t: number,
    local: number,
    duration: number,
    /** 關鍵影格 / 遮罩用的時間（片段特效有作用範圍時跟 local 不同） */
    keyLocal = local,
    /** 跟著臉的 point 參數（算好的位置） */
    pts?: Record<string, number[]>,
  ) {
    let mask = maskAt(fx.mask, fx.keys, keyLocal);
    if (fx.moduleId === CLIP_MASK_ID) {
      // 片段遮罩：沒設形狀 = 不動；有形狀 = 反轉後套用（遮罩內保留原畫面、遮罩外變透明）
      if (!mask) return this.pass(out, this.blit, (p) => this.bindTex(p, 'u_tex', src.tex, 0));
      mask = { ...mask, invert: !mask.invert };
    }
    const dst = mask ? tmp : out;
    this.pass(dst, g, (p) => {
      this.bindTex(p, 'u_tex', src.tex, 0);
      this.setCommon(p, t, local, duration, local / duration);
      this.setParams(p, fx.params, fx.keys, keyLocal, fx.audio, pts);
    });
    if (mask) this.maskPass(out, src, tmp, mask);
  }

  private shapeTexs = new Map<string, { field: ShapeField; tex: WebGLTexture }>();
  /** 形狀的距離場貼圖（還沒準備好 = null，先用矩形） */
  private shapeTex(id: string): WebGLTexture | null {
    const field = getShapeField(id);
    if (!field) return null;
    const cur = this.shapeTexs.get(id);
    if (cur?.field === field) return cur.tex;
    const gl = this.gl;
    const tex = cur?.tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, field.size, field.size, 0, gl.RED, gl.UNSIGNED_BYTE, field.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 遮罩自己的路徑每改一次就是新的 key：舊的貼圖別一直留著
    if (!cur && id.startsWith('path:') && this.shapeTexs.size > 64) {
      for (const [k, v] of this.shapeTexs) {
        if (!k.startsWith('path:')) continue;
        this.gl.deleteTexture(v.tex);
        this.shapeTexs.delete(k);
        break;
      }
    }
    this.shapeTexs.set(id, { field, tex });
    return tex;
  }

  private maskPass(out: Target, src: Target, fxTex: Target, m: Mask, over = false) {
    // 形狀貼圖要在綁貼圖之前拿：第一次用到時會建立貼圖（bindTexture 綁在目前的貼圖單元上），
    // 放在後面會把剛綁好的 u_fx 換掉，那一格畫錯（第一次出現的遮罩形狀那一格是紅的）
    const key = maskFieldKey(m);
    const tex = key === 'rect' || key === 'ellipse' ? null : this.shapeTex(key);
    this.pass(out, this.maskProg, (p) => {
      const gl = this.gl;
      this.bindTex(p, 'u_src', src.tex, 0);
      this.bindTex(p, 'u_fx', fxTex.tex, 1);
      gl.uniform1i(this.loc(p, 'u_shape'), m.shape === 'ellipse' ? 2 : tex ? 3 : 1);
      // 沒有形狀貼圖也綁一張不相干的（理由同 drawTex 的 u_matte）
      this.bindTex(p, 'u_shapeTex', tex ?? src.tex, 2);
      gl.uniform4f(this.loc(p, 'u_box'), m.x, m.y, Math.max(0, m.w), Math.max(0, m.h));
      gl.uniform1f(this.loc(p, 'u_feather'), Math.max(0, m.feather));
      gl.uniform1f(this.loc(p, 'u_rot'), (m.rotation * Math.PI) / 180);
      const mat = m.matrix;
      const det = mat ? mat[0] * mat[3] - mat[2] * mat[1] : 0;
      gl.uniform1f(this.loc(p, 'u_maskMatrix'), mat && Math.abs(det) > 1e-8 ? 1 : 0);
      if (mat && Math.abs(det) > 1e-8) gl.uniformMatrix2fv(this.loc(p, 'u_maskInv'), false,
        [mat[3] / det, -mat[1] / det, -mat[2] / det, mat[0] / det]);
      gl.uniform1f(this.loc(p, 'u_invert'), m.invert ? 1 : 0);
      gl.uniform1f(this.loc(p, 'u_over'), over ? 1 : 0);
    });
  }

  private animOutlines = new Map<string, string>();
  private animMask(item: AnimItem, draw: AnimDrawLayer, t: number, ctx: RenderCtx): Mask | null {
    const maskLayer = item.layers.find((l) => l.id === draw.mask?.layerId);
    const ref = item.slots.find((s) => s.id === (maskLayer?.slotId ?? draw.mask?.slotId));
    const media = ref?.mediaId && ctx.media.get(ref.mediaId);
    if (!ref || !media || media.missing) return null;
    // 有手動修正：輪廓照修正後的遮罩描（不用範本記的輪廓）
    const edit = slotEdit(ref);
    let path = edit ? undefined : ref.cutout?.outline;
    if (!path) {
      const matte = slotMatte(media, ref.sourceTime, edit);
      if (!matte) {
        requestMatte(animClip(item, { ...draw, slot: ref }), media, ctx.modules);
        return null;
      }
      path = this.animOutlines.get(matte.stamp);
      if (path === undefined) {
        path = traceMatte(matte.data, matte.size);
        if (this.animOutlines.size > 64) this.animOutlines.delete(this.animOutlines.keys().next().value!);
        this.animOutlines.set(matte.stamp, path);
      }
    }
    if (!path) return null;
    const aspect = this.w / this.h;
    const beat = animBeatAtTime(item, t, animBeatTime(item));
    const scale = draw.mask?.scale?.length ? evalKeys(draw.mask.scale, beat) : 1;
    const whole = animTransformAt(item, beat);
    const guide: AnimDrawLayer = animLayers(item, t, animBeatTime(item), aspect).find((l) => l.layer.id === maskLayer?.id)
      ?? { id: 'mask', slot: ref, layer: draw.layer, ...whole,
        ...(item.transform || item.keys ? { matrix: animMatrix(DEFAULT_TRANSFORM, whole) } : {}) };
    // 輪廓是整張素材的座標：框 = 素材照 cover（含裁切）畫進畫面的那一塊，不是整個畫面
    const at = animClip(item, { ...guide, slot: ref }, media, aspect);
    const F = fitSize(true, (media.width || this.w) / (media.height || this.h), aspect);
    const cw = F[0] / aspect, ch = F[1];
    const xf = at.transform;
    const pivot = draw.mask?.pivot;
    return { shape: 'path', path, invert: draw.mask?.mode === 'hole',
      x: xf.x + (pivot?.x ?? 0) * (1 - scale), y: xf.y + (pivot?.y ?? 0) * (1 - scale),
      w: Math.abs(xf.scaleX * scale) * cw, h: Math.abs(xf.scaleY * scale) * ch,
      rotation: xf.rotation, feather: 0,
      ...(at.animMatrix ? { matrix: at.animMatrix.map((v, i) => v * scale * (i < 2 ? cw : ch)) as [number, number, number, number] } : {}) };
  }

  render(ctx: RenderCtx, t: number, mode: 'preview' | 'export', playing = false, extra?: { module: Module; progress: number; duration: number }) {
    this.updateChains(ctx);
    const [TA, TB, P0, P1] = this.targets;
    const active = new Set<string>();
    this.clear(P0, true);
    let cur = P0;
    this.sig = audioSignal(ctx, t);
    this.sigAt = { ctx, t };
    this.sigFrom.clear();

    // 作用中的特效，依所在層（下面有幾條影片軌）分組
    const fxByLevel = new Map<number, FxItem[]>();
    for (const e of ctx.effects) {
      if (t < e.start || t >= e.start + e.duration || ctx.tracks.fx[e.track]?.hidden) continue;
      const lv = fxLevel(ctx.tracks, e.track);
      if (!fxByLevel.has(lv)) fxByLevel.set(lv, []);
      fxByLevel.get(lv)!.push(e);
    }
    // 「每個剪接點」觸發：選定影片軌的片段開頭（同一組軌道只算一次）
    const cutCache = new Map<string, number[]>();
    const cutsFor = (fx: FxItem) => {
      const idx = cutTracks(fx, ctx.tracks);
      const key = idx.join(',');
      let pts = cutCache.get(key);
      if (!pts) cutCache.set(key, (pts = cutPoints(ctx.clips, idx)));
      return pts;
    };
    const runFx = (lv: number) => {
      const list = (fxByLevel.get(lv) ?? []).sort((a, b) => a.track - b.track || a.start - b.start);
      for (const fx of list) {
        // 觸發：特效內時間從最近一次觸發開始算
        const tr = fx.trigger;
        let w: { t0: number; d: number } | null;
        if (tr?.kind === 'hits') {
          // 手動：方塊之間不作用；每個 Hit 播多長就是多長
          const timing = { kind: 'hits' as const, hits: tr.hits };
          const h = fxWindow(timing, t - fx.start, fx.duration);
          w = h && { t0: fx.start + h.t0, d: h.d };
          this.trig = h ? timingIndex(timing, h.t0) : 0;
        } else {
          const pts = tr ? (tr.kind === 'cut' ? cutsFor(fx) : triggerBeats(tr.every)) : null;
          const raw = !pts ? { t0: fx.start, d: fx.duration }
            : hasChance(tr) ? chanceWindow(tr!, pts, fx.start, fx.start + fx.duration, t)
              : triggerWindow(pts, fx.start, fx.start + fx.duration, t);
          // 衝擊特效每次觸發只打一下（長度 = 主特效的 @duration）；設了延伸就播到下一次觸發
          w = pts && !tr?.extend ? hitWindow(raw, t, this.hitLen(ctx.modules.get(fx.moduleId))) : raw;
          this.trig = pts && w ? triggerIndex(tr, pts, fx.start, w.t0) : 0;
        }
        // 有機率 / 手動：沒挑中的拍子、方塊之間不作用
        if (!w) continue;
        // 主特效 + 疊加的特效，依序套用
        for (const f of [fx, ...(fx.stack ?? []).filter((x) => x.enabled !== false)]) {
          const m = ctx.modules.get(f.moduleId);
          const g = m ? this.moduleProg(m) : null;
          if (!g) continue;
          const followPts = this.followed(g, f.follow, () => subjectClipUnder(ctx, lv, t, fx.subjectFrom), ctx);
          cur = this.applyFx(cur, f, g, t, t - w.t0, w.d, this.scattered(g, tr, this.trig, followPts));
        }
        this.trig = 0;
      }
    };

    // 影片軌由下（軌 1）往上疊；特效軌插在影片軌之間，只影響它下面已經疊好的畫面（調整圖層）
    ctx.videoTracks.forEach((clips, ti) => {
      runFx(ti);
      if (ctx.tracks.video[ti]?.hidden) return;
      const P0 = cur;
      const fr = computeFrame(clips, t);
      if (fr.kind === 'clip') {
        active.add(fr.clip.id);
        this.drawClip(P0, fr.clip, t, ctx, mode, playing, fr.clip.blend ?? true);
      } else if (fr.kind === 'transition') {
        this.clear(TA, false);
        this.clear(TB, false);
        if (fr.A) {
          active.add(fr.A.id);
          this.drawClip(TA, fr.A, t, ctx, mode, playing, false);
        }
        if (fr.B) {
          active.add(fr.B.id);
          this.drawClip(TB, fr.B, t, ctx, mode, playing, false);
        }
        const tr = fr.tr;
        // 轉場期間的混合模式：前半用前一段、後半用後一段的設定
        const trBlend: Blend = (fr.progress < 0.5 ? fr.A ?? fr.B : fr.B ?? fr.A)?.blend ?? true;
        const m = ctx.modules.get(tr.moduleId);
        const g = m ? this.moduleProg(m) : null;
        if (g) {
          this.pass(P0, g, (p) => {
            this.bindTex(p, 'u_from', TA.tex, 0);
            this.bindTex(p, 'u_to', TB.tex, 1);
            this.setCommon(p, t, fr.progress * fr.d, fr.d, fr.progress);
            const side = (f: Follow) => {
              const c = f.side === 'to' ? fr.B ?? fr.A : fr.A ?? fr.B;
              return c ? { clip: c, local: t - c.start } : null;
            };
            this.setParams(p, tr.params, undefined, 0, undefined, this.followed(g, tr.follow, side, ctx));
          }, trBlend);
        } else {
          this.pass(P0, this.blit, (p) => this.bindTex(p, 'u_tex', fr.progress < 0.5 ? TA.tex : TB.tex, 0), trBlend);
        }
      }
      for (const item of ctx.anims) {
        if (item.track !== ti) continue;
        // 整體遮罩：每個圖層先照平常疊好，再依遮罩跟疊之前的畫面混（遮罩外 = 沒疊這個圖層）
        const beat = animBeatAtTime(item, t, animBeatTime(item));
        const whole = item.mask ? animMaskAt(item, beat) : null;
        const aspect = this.w / this.h;
        for (const draw of animLayers(item, t, animBeatTime(item), aspect)) {
          const media = ctx.media.get(draw.slot.mediaId!);
          if (!draw.layer.text && (!media || media.missing)) continue;
          const clip = animClip(item, draw, media, aspect);
          active.add(clip.id);
          // 遮罩：剪影窗 / 挖洞的輪廓、圖層自己的遮罩（跟著圖層）、整體遮罩，全部都要過（交集）
          const masks: Mask[] = [];
          if (draw.mask) {
            const outline = this.animMask(item, draw, t, ctx);
            if (!outline) continue;
            masks.push(outline);
          }
          const own = draw.layer.clipMask ? layerMaskAt(draw.layer, beat) : null;
          if (own) masks.push(layerMaskToScreen(own, draw, aspect));
          if (whole) masks.push(whole);
          if (!masks.length) {
            this.drawClip(cur, clip, t, ctx, mode, playing, clip.blend ?? true);
            continue;
          }
          // 先照平常疊好（含混合模式），再依每個遮罩跟疊之前的畫面混：遮罩外 = 沒疊這個圖層
          const other = cur === this.targets[2] ? this.targets[3] : this.targets[2];
          const base = cur;
          this.pass(other, this.blit, (p) => this.bindTex(p, 'u_tex', base.tex, 0));
          this.drawClip(other, clip, t, ctx, mode, playing, clip.blend ?? true);
          let src = other;
          for (const m of masks) {
            const dst = src === other ? TB : other;
            this.maskPass(dst, base, src, m);
            src = dst;
          }
          if (src === other) cur = other;
          else this.pass(cur, this.blit, (p) => this.bindTex(p, 'u_tex', TB.tex, 0));
        }
      }
    });

    // 最上層的特效（在所有影片軌上方）
    runFx(ctx.videoTracks.length);

    // 素材庫預覽：把點選的特效 / 轉場疊在目前畫面上循環播放
    if (extra) {
      const g = this.moduleProg(extra.module);
      if (g) {
        const out = cur === P0 ? P1 : P0;
        const src = cur;
        if (extra.module.kind === 'effect') {
          this.pass(out, g, (p) => {
            this.bindTex(p, 'u_tex', src.tex, 0);
            this.setCommon(p, t, extra.progress * extra.duration, extra.duration, extra.progress);
            this.setParams(p, {});
          });
        } else {
          this.clear(TB, true);
          this.pass(TB, this.blit, (p) => this.bindTex(p, 'u_tex', this.sampleTex(), 0));
          this.pass(out, g, (p) => {
            this.bindTex(p, 'u_from', src.tex, 0);
            this.bindTex(p, 'u_to', TB.tex, 1);
            this.setCommon(p, t, extra.progress * extra.duration, extra.duration, extra.progress);
            this.setParams(p, {});
          });
        }
        cur = out;
      }
    }

    this.pass(null, this.blit, (p) => this.bindTex(p, 'u_tex', cur.tex, 0));
    if (mode === 'preview') {
      holdScrub(playing); // 播放中不抽拖曳用的影格（解碼器留給預覽）；代理檔照做（在 Worker 裡，而且做好了播放才會順）
      this.manageVideos(ctx, t, active, playing);
      prefetchReverse(ctx, t);
    }
  }

  /** 暫停非作用中的影片、預先 seek 即將出現的片段、回收已刪除片段 */
  private manageVideos(ctx: RenderCtx, t: number, active: Set<string>, playing = false) {
    const ids = new Set(ctx.clips.map((c) => c.id));
    for (const key of [...this.textState.keys()]) {
      if (ids.has(key.slice(4))) continue;
      this.textState.delete(key);
      const tex = this.textures.get(key);
      if (tex) this.gl.deleteTexture(tex);
      this.textures.delete(key);
    }
    const activeRoots = new Set([...active].map((id) => this.rootOf(id)));
    // 動畫的圖層不是時間軸上的片段：這一格畫到的也要留著（不然每格建了又刪，影片永遠載不出來）
    const roots = new Set([...ctx.clips.map((c) => this.rootOf(c.id)), ...activeRoots]);
    // 每串（共用同一個 <video> 的片段）最後結束的時間
    const chainEnd = new Map<string, number>();
    for (const c of ctx.clips) {
      const k = this.rootOf(c.id);
      chainEnd.set(k, Math.max(chainEnd.get(k) ?? -Infinity, c.start + c.duration));
    }
    for (const [id, v] of this.videos) {
      if (!roots.has(id) || (!activeRoots.has(id) && (chainEnd.get(id) ?? Infinity) < t - RELEASE_AFTER)) {
        v.pause();
        v.removeAttribute('src');
        v.load();
        this.videos.delete(id);
        const tex = this.textures.get('vid:' + id);
        if (tex) this.gl.deleteTexture(tex);
        this.textures.delete('vid:' + id);
      }
    }
    // 每個影片元素只處理一次：正在畫的跳過；其他的用串接裡「還沒播完、最早的那段」決定要預先 seek / 預播到哪
    const handled = new Set<string>();
    for (const c of [...ctx.clips].sort((a, b) => a.start - b.start)) {
      const key = this.rootOf(c.id);
      if (activeRoots.has(key) || handled.has(key) || c.start + c.duration <= t) continue;
      // 還很遠的片段：先不建立 <video>（已經有的照常處理）
      if (c.start - t > CREATE_AHEAD && !this.videos.has(key)) continue;
      handled.add(key);
      const media = ctx.media.get(c.mediaId);
      if (!media || media.missing || media.kind !== 'video') continue;
      const v = this.videoFor(c, media, true);
      v.muted = true;
      const ahead = c.start - t;
      // 播放中、下一段快到了：提前（靜音）開始播放，接上時影片已經在跑，不會因為 play() 的啟動延遲而卡一下
      const speed = playing && ahead > 0 && ahead < PREROLL ? plainSpeed(c, ctx.modules) : null;
      if (speed !== null && speed >= 0.0625 && speed <= 16) {
        const { src } = clipSource(c, 0, media, ctx.modules);
        const want = src - ahead * speed;
        if (want < 0 && ahead > 0.12) continue; // 片段從素材開頭開始：太早播會超前，等近一點再開始
        if (v.paused) {
          if (!v.seeking && Math.abs(v.currentTime - Math.max(0, want)) > 0.05) v.currentTime = Math.max(0, want);
          v.playbackRate = speed;
          v.play().catch(() => {});
        }
        continue;
      }
      if (!v.paused) v.pause();
      if (ahead > 0 && ahead < CREATE_AHEAD && !v.seeking) {
        const { src } = clipSource(c, 0, media, ctx.modules);
        if (Math.abs(v.currentTime - src) > 0.01) v.currentTime = src;
      }
    }
    // 整串都已經播完的影片元素：暫停
    for (const [key, v] of this.videos) if (!activeRoots.has(key) && !handled.has(key) && !v.paused) v.pause();
  }

  /** 產生特效 / 轉場的預覽縮圖（畫在自己的 canvas 上） */
  thumb(module: Module, progress: number, a: TexImageSource, b: TexImageSource, duration: number): boolean {
    const g = this.moduleProg(module);
    if (!g) return false;
    const [, TB, P0, P1] = this.targets;
    const ta = this.upload('thumbA', a);
    this.pass(P0, this.blit, (p) => this.bindTex(p, 'u_tex', ta, 0));
    if (module.kind === 'effect') {
      this.pass(P1, g, (p) => {
        this.bindTex(p, 'u_tex', P0.tex, 0);
        this.setCommon(p, progress * duration, progress * duration, duration, progress);
        this.setParams(p, {});
      });
    } else {
      const tb = this.upload('thumbB', b);
      this.pass(TB, this.blit, (p) => this.bindTex(p, 'u_tex', tb, 0));
      this.pass(P1, g, (p) => {
        this.bindTex(p, 'u_from', P0.tex, 0);
        this.bindTex(p, 'u_to', TB.tex, 1);
        this.setCommon(p, progress * duration, progress * duration, duration, progress);
        this.setParams(p, {});
      });
    }
    this.pass(null, this.blit, (p) => this.bindTex(p, 'u_tex', P1.tex, 0));
    return true;
  }

  pauseAll() {
    for (const v of this.videos.values()) {
      v.pause();
      v.muted = true;
    }
  }

  /** 匯出用：精準 seek 到每個需要的影格，確定畫面就緒後才回傳 */
  private exportFrames = new Map<string, { frame: VideoFrame; pts: number }>();
  private exportUploaded = new Set<string>();

  clearExportFrames() { this.exportFrames.clear(); this.exportUploaded.clear(); }

  async prepareExact(ctx: RenderCtx, t: number, frameFor?: ExportFrameSource) {
    this.clearExportFrames();
    this.updateChains(ctx);
    const list: [Clip, number][] = [];
    for (const clips of ctx.videoTracks) {
      const fr = computeFrame(clips, t);
      if (fr.kind === 'clip') list.push([fr.clip, t - fr.clip.start]);
      else if (fr.kind === 'transition') for (const c of [fr.A, fr.B]) if (c) list.push([c, t - c.start]);
    }
    for (const item of ctx.anims) for (const draw of animLayers(item, t, animBeatTime(item), this.w / this.h)) {
      if (draw.layer.text || !ctx.media.has(draw.slot.mediaId!)) continue;
      list.push([animClip(item, draw), t - item.start]);
    }
    for (const [c, local] of list) {
      const media = ctx.media.get(c.mediaId);
      if (!media || media.missing) continue;
      if (media.kind === 'image') {
        const img = this.image(media);
        if (!img.complete) await img.decode().catch(() => {});
        await animImageReady(media); // 動態圖片：匯出前要解完，不然前幾格會是靜態的
        continue;
      }
      if (media.kind !== 'video') continue;
      if (frameFor) {
        const { src } = clipSource(c, local, media, ctx.modules);
        const frame = await frameFor(c, media, src);
        if (frame) {
          this.exportFrames.set(c.id, { frame, pts: frame.timestamp / 1e6 });
          continue;
        }
      }
      const v = this.videoFor(c, media, false);
      v.pause();
      if (v.readyState < 1) await waitEvent(v, 'loadedmetadata');
      const { src } = clipSource(c, local, media, ctx.modules);
      if (Math.abs(v.currentTime - src) > 1e-4 || v.readyState < 2) {
        const done = waitEvent(v, 'seeked');
        v.currentTime = src;
        if (await done) continue;
        // 跳轉逾時（解碼器卡住了）：換一個新的 <video> 再試一次，不然之後每一格都要等逾時
        this.dropVideo(c);
        const w = this.videoFor(c, media, false);
        if (w.readyState < 1) await waitEvent(w, 'loadedmetadata');
        const again = waitEvent(w, 'seeked');
        w.currentTime = src;
        await again;
      }
    }
  }

  /** 丟掉這個片段用的 <video>（下次 videoFor 會建新的）；馬上放掉解碼器 */
  private dropVideo(clip: Clip) {
    const key = this.rootOf(clip.id);
    const v = this.videos.get(key);
    if (!v) return;
    this.videos.delete(key);
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
}

/** 等事件；true = 等到了、false = 逾時 */
function waitEvent(el: HTMLElement, ev: string, timeout = 4000) {
  return new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      el.removeEventListener(ev, hit);
      clearTimeout(timer);
      resolve(ok);
    };
    const hit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    el.addEventListener(ev, hit);
  });
}

// ───────────────────────── singleton ─────────────────────────

let instance: Renderer | null = null;
export const setRenderer = (r: Renderer | null) => (instance = r);
export const getRenderer = () => instance;

const ctxCache = { key: [] as unknown[], ctx: null as RenderCtx | null };
/**
 * 轉場方塊：方塊範圍內、選定影片軌上的每個剪接點（前面緊貼著片段），片段自己沒有進場轉場的，套上方塊的轉場。
 * clips 要是同一條軌道、排序過；回傳新的陣列（有改的片段是複製的，store 裡的不動）
 */
export function applyTransitionBlocks(clips: Clip[], track: number, blocks: FxItem[], tracks: Tracks): Clip[] {
  const mine = blocks.filter((b) => !tracks.fx[b.track]?.hidden && cutTracks(b, tracks).includes(track));
  if (!mine.length) return clips;
  return clips.map((c, i) => {
    if (i === 0 || c.transitionIn || !adjacent(clips[i - 1], c)) return c;
    const b = mine.find((x) => c.start >= x.start - ADJ_EPS && c.start <= x.start + x.duration + ADJ_EPS);
    return b ? { ...c, transitionIn: { moduleId: b.moduleId, params: b.params, duration: b.trDur ?? 0.4, ...(b.follow ? { follow: b.follow } : {}) } } : c;
  });
}

export function makeCtx(s: { clips: Clip[]; effects: FxItem[]; modules: Module[]; media: Media[]; tracks: Tracks; audios?: AudioClip[]; anims?: AnimItem[] }): RenderCtx {
  const key = [s.clips, s.effects, s.modules, s.media, s.tracks, s.audios, s.anims];
  if (ctxCache.ctx && key.every((k, i) => k === ctxCache.key[i])) return ctxCache.ctx;
  ctxCache.key = key;
  const modules = new Map(s.modules.map((m) => [m.id, m]));
  // 轉場方塊（特效軌上的轉場）：不當特效渲染，而是套到範圍內每個剪接點上
  const blocks = s.effects.filter((e) => modules.get(e.moduleId)?.kind === 'transition');
  const videoTracks = s.tracks.video.map((_, i) => applyTransitionBlocks(sortClips(s.clips.filter((c) => c.track === i)), i, blocks, s.tracks));
  ctxCache.ctx = {
    clips: s.clips,
    audios: s.audios ?? [],
    videoTracks,
    effects: blocks.length ? s.effects.filter((e) => !blocks.includes(e)) : s.effects,
    anims: s.anims ?? [],
    tracks: s.tracks,
    modules,
    media: new Map(s.media.map((m) => [m.id, m])),
    linked: new Set((s.audios ?? []).map((a) => a.link).filter((x): x is string => !!x)),
  };
  return ctxCache.ctx;
}
