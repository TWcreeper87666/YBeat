import { $t } from './i18n';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { BUILTIN_MODULES, NEW_MODULE_TEMPLATES, type Module, type ModuleKind } from './modules/builtin';
import { parseDuration, type ParamValues } from './engine/params';
import { clipSource, plainSpeed } from './engine/remap';
import { DEFAULT_TRANSFORM, EASES, normalizeScale, type EaseName, type Fit, type Transform } from './engine/transform';
import { DEFAULT_TRACKS, TRACK_H, displayRows, fxLevel, tracksFromOrder, visualRows, type TrackKind, type TrackState, type Tracks } from './engine/tracks';
export { DEFAULT_TRACKS, TRACK_H, displayRows, fxLevel, tracksFromOrder, visualRows, type TrackKind, type TrackState, type Tracks };
import { ANIM_PROPS, newKey, scaleKeyMap, splitKeys, type Ease, type Keyframe, type Keys } from './engine/keyframes';
import { fitStart, groupFits, resolveShift, type Span } from './engine/overlap';
import { DEFAULT_TEXT, TEXT_PRESETS, type TextStyle } from './engine/text';
import type { Mask } from './engine/mask';

export type { Module, ModuleKind };

export interface Media {
  id: string;
  name: string;
  kind: 'image' | 'video' | 'audio';
  url: string;
  width: number;
  height: number;
  duration: number;
  thumb: string;
  hasAudio: boolean;
  peaks?: number[];
  peaksPerSec?: number;
  /** 檔案遺失（重新整理後找不到 / 被移除），需要重新連結 */
  missing?: boolean;
}

export interface TransitionRef {
  moduleId: string;
  params: ParamValues;
  duration: number;
}

/** 所有時間軸項目共用的欄位 */
export interface ItemBase {
  /** 使用者取的名稱（沒有就顯示素材 / 模組名稱） */
  name?: string;
  /** 影音連結：同一個 id 的影片片段與音訊片段一起選取、一起編輯 */
  link?: string;
  /** 群組：同一個 id 的項目一起選取、一起移動 */
  group?: string;
}

/** 特效參數跟著音訊變化 */
export interface AudioDrive {
  source: 'level' | 'beat';
  min: number;
  max: number;
}

/** 套在單一片段上的特效（可以疊好幾個，只影響這個片段） */
export interface ClipFx {
  id: string;
  moduleId: string;
  params: ParamValues;
  /** 參數 / 遮罩的關鍵影格（片段內時間） */
  keys?: Record<string, Keyframe[]>;
  mask?: Mask;
  audio?: Record<string, AudioDrive>;
  /** false = 暫時關閉 */
  enabled?: boolean;
}

export interface Clip extends ItemBase {
  id: string;
  mediaId: string;
  track: number;
  start: number;
  duration: number;
  in: number;
  remap: { moduleId: string; params: ParamValues };
  transitionIn: TransitionRef | null;
  /** 片段特效（由上往下依序套用） */
  effects?: ClipFx[];
  /** 轉出（後面沒有緊貼的片段時，轉到透明） */
  transitionOut?: TransitionRef | null;
  fit: Fit;
  /** 舊版的水平翻轉（載入時轉成負的 scaleX，之後一律是 false） */
  flipX: boolean;
  /** 縮放 X / Y 不等比例（沒設定 = 等比例：改其中一個，另一個依比例跟著變、各自保留正負號） */
  scaleUnlinked?: boolean;
  /** 沒有關鍵影格時的固定值 */
  transform: Transform;
  /** 關鍵影格（片段內時間） */
  keys: Keys;
  volume: number;
  /** 整體播放速率（Ctrl+拖曳邊緣調整；一般變速模組會直接改它的 speed 參數） */
  rate: number;
  /** 文字 / 字幕片段（沒有素材，mediaId 為空字串） */
  text?: TextStyle;
  /** 影片原音變速時保持音調（沒設定 = 保持；有連結音訊時看音訊片段的設定） */
  keepPitch?: boolean;
  /** 混合模式（疊到下面圖層的方式），預設 normal */
  blend?: BlendMode;
  /** 原音已分離成獨立音訊片段（影片本身不再出聲，屬性面板不顯示「聲音」） */
  audioSplit?: boolean;
  /** 舊版欄位，載入時會轉成 keys */
  transformEnd?: Transform | null;
  ease?: EaseName;
}

export type BlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'subtract' | 'lighten';

export interface FxItem extends ItemBase {
  id: string;
  moduleId: string;
  params: ParamValues;
  /** 參數跟著音量 / 節拍變化 */
  audio?: Record<string, AudioDrive>;
  /** 數值參數的關鍵影格（特效內時間）；遮罩的 key 叫 `mask.x` 之類 */
  keys?: Record<string, Keyframe[]>;
  /** 遮罩：只在這個區域套用特效 */
  mask?: Mask;
  start: number;
  duration: number;
  track: number;
}

export interface AudioClip extends ItemBase {
  id: string;
  mediaId: string;
  track: number;
  start: number;
  duration: number;
  in: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** 播放速率 */
  rate: number;
  /** 變速時保持音調（沒設定 = 保持） */
  keepPitch?: boolean;
}

/** 輸出畫面大小（比例） */
export interface Format { w: number; h: number }
export const FORMATS: { id: string; label: string; w: number; h: number }[] = [
  { id: '9:16', label: '9:16', w: 1080, h: 1920 },
  { id: '16:9', label: '16:9', w: 1920, h: 1080 },
  { id: '1:1', label: '1:1', w: 1080, h: 1080 },
  { id: '4:5', label: '4:5', w: 1080, h: 1350 },
  { id: '3:4', label: '3:4', w: 1080, h: 1440 },
  { id: '4:3', label: '4:3', w: 1440, h: 1080 },
  { id: '21:9', label: '21:9', w: 2520, h: 1080 },
];
export const DEFAULT_FORMAT: Format = { w: 1080, h: 1920 };
export const formatLabel = (f: Format) => FORMATS.find((x) => x.w === f.w && x.h === f.h)?.label ?? `${f.w}×${f.h}`;

export type ItemType = 'clip' | 'effect' | 'audio';
export type AnyItem = Clip | FxItem | AudioClip;
export type Selection = { type: ItemType | 'transition' | 'module'; id: string } | null;
export type TrSide = 'in' | 'out';
export type TrScope = 'cuts' | 'heads' | 'tails' | 'all';
/** 轉場的選取 id：進場 = clipId，轉出 = `out:clipId` */
export const trSelId = (clipId: string, side: TrSide) => (side === 'out' ? `out:${clipId}` : clipId);
export const parseTrSel = (id: string): { clipId: string; side: TrSide } => (id.startsWith('out:') ? { clipId: id.slice(4), side: 'out' } : { clipId: id, side: 'in' });
export type SelectMode = 'replace' | 'toggle' | 'range';
export type LeftTab = 'media' | 'transition' | 'effect' | 'remap' | 'editor';
type Clipboard = { items: { type: ItemType; item: AnyItem }[] } | null;

/** 多選用的 key：`clip:abc` */
export const keyOf = (type: ItemType, id: string) => `${type}:${id}`;
export const parseKey = (k: string) => {
  const i = k.indexOf(':');
  return { type: k.slice(0, i) as ItemType, id: k.slice(i + 1) };
};
export const KIND_OF: Record<ItemType, TrackKind> = { clip: 'video', effect: 'fx', audio: 'audio' };
export const LIST = { clip: 'clips', effect: 'effects', audio: 'audios' } as const;
const isItem = (t: string | undefined): t is ItemType => t === 'clip' || t === 'effect' || t === 'audio';

interface State {
  media: Media[];
  clips: Clip[];
  effects: FxItem[];
  audios: AudioClip[];
  tracks: Tracks;
  modules: Module[];
  /** 主選取（左側編輯器顯示它） */
  selection: Selection;
  /** 多選清單（keyOf） */
  selected: string[];
  clipboard: Clipboard;
  errors: Record<string, string | null>;
  time: number;
  playing: boolean;
  loop: { a: number; b: number } | null;
  pps: number;
  snap: boolean;
  leftTab: LeftTab;
  exporting: { progress: number; cancel: boolean } | null;
  /** 輸出畫面大小 */
  format: Format;
  setFormat(f: Format): void;

  addMedia(m: Media): void;
  /** range：從素材預覽設定的入點 / 長度 */
  addClip(mediaId: string, start?: number, track?: number, range?: { in: number; duration: number }): void;
  addAudio(mediaId: string, start?: number, track?: number, range?: { in: number; duration: number }): void;
  updateClip(id: string, patch: Partial<Clip>): void;
  updateAudio(id: string, patch: Partial<AudioClip>): void;
  patchItems(patches: Record<string, Partial<AnyItem>>): void;
  setTransition(clipId: string, moduleId: string | null, side?: TrSide): void;
  updateTransition(clipId: string, patch: Partial<TransitionRef>, side?: TrSide): void;
  /** 在一條影片軌上批次套用轉場：剪接點 / 片段開頭（從透明轉入）/ 片段結尾（轉到透明） */
  applyTransitions(track: number, scope: TrScope, tpl: { moduleId: string; params?: ParamValues; duration?: number }): number;
  /** 選中的軌道（插入片段時放在這條軌道） */
  activeTrack: { kind: TrackKind; idx: number } | null;
  /** 時間軸的上下顯示方式（從設定同步過來，決定「最下方」是哪裡） */
  upperAt: 'top' | 'bottom';
  setActiveTrack(t: { kind: TrackKind; idx: number } | null): void;
  /** 在播放頭插入：放在選中的軌道；那裡被佔用就在旁邊新增一條軌道 */
  trackForInsert(kind: TrackKind, start: number, duration: number): number;
  setRemap(clipId: string, moduleId: string): void;
  addEffect(moduleId: string, start: number, track?: number): void;
  addText(presetId: string, start?: number, track?: number): void;
  updateEffect(id: string, patch: Partial<FxItem>): void;
  /** 換成另一個特效模組（參數與參數的關鍵影格會清掉，遮罩保留） */
  replaceEffect(id: string, moduleId: string): void;
  relinkMedia(oldId: string, newId: string): void;
  /** ripple = true：同一軌往前推；'all'：所有軌道一起往前推（其他軌被擋住時只推到不重疊為止） */
  removeSelection(ripple?: boolean | 'all'): void;
  /** 沒有選取時：移除選中軌道上播放頭所在的空白，後面的項目往前推 */
  removeGap(): boolean;
  split(): void;
  trim(side: 'start' | 'end'): void;
  nudge(dt: number): void;
  copy(): void;
  cut(): void;
  paste(at?: { time: number; track: number; kind: TrackKind }): void;
  duplicate(): void;
  /** level：特效軌放在第幾條影片軌上方（沒給就自動） */
  addTrack(kind: TrackKind, at?: number, level?: number, row?: number): void;
  moveTrack(kind: TrackKind, from: number, to: number): void;
  /** 依顯示順序（由上到下、所有軌道）重新排列；影片 / 特效 / 音訊軌可以任意交錯 */
  reorderTracks(order: { kind: TrackKind; idx: number }[]): void;
  /** 刪除軌道（連同上面的項目）；影片軌至少要留一條 */
  deleteTrack(kind: TrackKind, idx: number): boolean;
  /** 軌道上有幾個項目（刪除前確認用） */
  trackItemCount(kind: TrackKind, idx: number): number;
  toggleTrack(kind: TrackKind, idx: number, key: 'hidden' | 'muted'): void;
  setTrackHeight(kind: TrackKind, idx: number, h: number | undefined): void;
  /** 特效軌放到第 level 條影片軌上方（0 = 最底下） */
  setFxLevel(idx: number, level: number): void;
  select(sel: Selection, mode?: SelectMode): void;
  selectKeys(keys: string[], additive?: boolean): void;
  selectAll(): void;
  renameItem(type: ItemType, id: string, name: string): void;
  /** 片段特效：加入 / 修改 / 移除 / 排序 */
  addClipFx(clipId: string, moduleId: string): void;
  updateClipFx(clipId: string, fxId: string, patch: Partial<ClipFx>): void;
  removeClipFx(clipId: string, fxId: string): void;
  moveClipFx(clipId: string, fxId: string, dir: -1 | 1): void;
  /** 選取的影片 + 音訊建立連結 */
  linkSelected(): boolean;
  /** 取消選取項目的影音連結 */
  unlinkSelected(): void;
  groupSelected(): boolean;
  ungroupSelected(): void;
  /** 合併選取中、首尾相接而且素材連續的片段；回傳合併了幾組 */
  mergeSelected(): number;
  updateModuleCode(id: string, code: string): void;
  renameModule(id: string, name: string): void;
  forkModule(id: string): string;
  resetModule(id: string): void;
  createModule(kind: ModuleKind, init?: { name?: string; code?: string }): string;
  /** 刪除自訂模組；內建或還有東西在用 → 不刪、回傳 false */
  removeModule(id: string): boolean;
  setError(id: string, msg: string | null): void;
  setTime(t: number): void;
  setPlaying(p: boolean): void;
  togglePlay(): void;
  setLoop(l: { a: number; b: number } | null): void;
  setPps(p: number): void;
  setSnap(s: boolean): void;
  setLeftTab(t: LeftTab): void;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export function projectDuration(s: { clips: Clip[]; effects: FxItem[]; audios: AudioClip[] }) {
  let end = 0;
  for (const c of s.clips) end = Math.max(end, c.start + c.duration);
  for (const e of s.effects) end = Math.max(end, e.start + e.duration);
  for (const a of s.audios) end = Math.max(end, a.start + a.duration);
  return end;
}

const LEGACY_EASE: Record<EaseName, Ease> = {
  linear: [0, 0, 1, 1], in: [0.42, 0, 1, 1], out: [0, 0, 0.58, 1], inOut: [0.42, 0, 0.58, 1], outBack: [0.34, 1.56, 0.64, 1],
};
void EASES;

export function makeClip(p: Partial<Clip> & { mediaId: string }): Clip {
  const c: Clip = {
    id: uid(),
    track: 0,
    start: 0,
    duration: 2,
    in: 0,
    remap: { moduleId: 'remap-speed', params: {} },
    transitionIn: null,
    fit: 'cover',
    flipX: false,
    transform: { ...DEFAULT_TRANSFORM },
    keys: {},
    volume: 1,
    rate: 1,
    ...p,
  };
  // 舊版只有 scale → scaleX / scaleY（transformEnd 也要轉，下面的舊版動態轉換才拿得到值）
  Object.assign(c, normalizeScale(c));
  if (c.transformEnd && (c.transformEnd as { scale?: number }).scale !== undefined) {
    const s = (c.transformEnd as { scale?: number }).scale!;
    c.transformEnd = { ...c.transformEnd, scaleX: s, scaleY: s };
  }
  // 舊版「水平翻轉」→ 負的縮放 X（關鍵影格也一起反過來）
  if (c.flipX) {
    c.transform = { ...c.transform, scaleX: -c.transform.scaleX };
    if (c.keys.scaleX) c.keys = { ...c.keys, scaleX: c.keys.scaleX.map((k) => ({ ...k, v: -k.v })) };
    if (c.transformEnd) c.transformEnd = { ...c.transformEnd, scaleX: -c.transformEnd.scaleX };
    c.flipX = false;
  }
  // 舊版「起點 → 終點」動態 → 兩個關鍵影格
  if (c.transformEnd) {
    const keys: Keys = { ...c.keys };
    const e = LEGACY_EASE[c.ease ?? 'inOut'];
    for (const { prop } of ANIM_PROPS) {
      if (c.transform[prop] !== c.transformEnd[prop]) keys[prop] = [newKey(0, c.transform[prop], e), newKey(c.duration, c.transformEnd[prop], e)];
    }
    c.keys = keys;
  }
  delete c.transformEnd;
  delete c.ease;
  return c;
}

export function makeAudio(p: Partial<AudioClip> & { mediaId: string }): AudioClip {
  return { id: uid(), track: 0, start: 0, duration: 5, in: 0, volume: 1, fadeIn: 0, fadeOut: 0, rate: 1, ...p };
}

const trackEnd = (items: { start: number; duration: number; track: number }[], track: number) =>
  items.filter((i) => i.track === track).reduce((e, c) => Math.max(e, c.start + c.duration), 0);

/**
 * 以 anchor 為中心把項目的時間縮放 s 倍（Ctrl+拖曳邊緣 = 變速）。
 * 長度 ×s、速度 ÷s，關鍵影格與轉場長度一起縮放。
 */
export function stretchPatch(type: ItemType, it: AnyItem, anchor: number, s: number): Partial<AnyItem> {
  const base = { start: anchor + (it.start - anchor) * s, duration: it.duration * s };
  if (type === 'clip') {
    const c = it as Clip;
    const patch: Partial<Clip> = { ...base, keys: scaleKeyMap(c.keys, s) };
    if (c.remap.moduleId === 'remap-speed') {
      const sp = Number(c.remap.params.speed ?? 1);
      patch.remap = { ...c.remap, params: { ...c.remap.params, speed: Math.round((sp / s) * 1000) / 1000 } };
    } else patch.rate = Math.round(((c.rate ?? 1) / s) * 1000) / 1000;
    if (c.transitionIn) patch.transitionIn = { ...c.transitionIn, duration: c.transitionIn.duration * s };
    if (c.transitionOut) patch.transitionOut = { ...c.transitionOut, duration: c.transitionOut.duration * s };
    if (c.effects?.length) patch.effects = c.effects.map((f) => (f.keys ? { ...f, keys: scaleKeyMap(f.keys, s) as Record<string, Keyframe[]> } : f));
    return patch;
  }
  if (type === 'audio') return { ...base, rate: ((it as AudioClip).rate ?? 1) / s } as Partial<AudioClip>;
  const f = it as FxItem;
  return { ...base, keys: scaleKeyMap(f.keys, s) } as Partial<FxItem>;
}

/** 片段目前的整體速度（顯示用） */
export function itemSpeed(type: ItemType, it: AnyItem): number | null {
  if (type === 'clip') {
    const c = it as Clip;
    const sp = c.remap.moduleId === 'remap-speed' ? Number(c.remap.params.speed ?? 1) : 1;
    return sp * (c.rate ?? 1);
  }
  if (type === 'audio') return (it as AudioClip).rate ?? 1;
  return null;
}

/** 素材是否可用（存在且沒遺失） */
export const mediaUsable = (m: Media | undefined): m is Media => !!m && !m.missing;

export const isTextClip = (c: Clip | undefined): c is Clip & { text: TextStyle } => !!c?.text;

/** 時間軸項目的碰撞範圍（排除 exclude 裡的 key） */
export function spansOf(s: { clips: Clip[]; effects: FxItem[]; audios: AudioClip[] }, exclude: Set<string> = new Set()): Span[] {
  const out: Span[] = [];
  const attached = attachedAudioIds(s);
  (['clip', 'effect', 'audio'] as ItemType[]).forEach((type) => {
    for (const it of s[LIST[type]] as AnyItem[]) {
      // 連結在影片片段上的音訊跟著影片顯示，不佔音訊軌的位置
      if (type === 'audio' && attached.has(it.id)) continue;
      if (!exclude.has(keyOf(type, it.id))) out.push({ lane: `${KIND_OF[type]}:${it.track}`, start: it.start, duration: it.duration });
    }
  });
  return out;
}
export const laneOf = (type: ItemType, track: number) => `${KIND_OF[type]}:${track}`;

/** 連結在影片片段上的音訊片段 id（時間軸上跟影片畫在一起，不出現在音訊軌） */
const attachedCache = { clips: null as Clip[] | null, audios: null as AudioClip[] | null, ids: new Set<string>() };
export function attachedAudioIds(s: { clips: Clip[]; audios: AudioClip[] }): Set<string> {
  if (attachedCache.clips === s.clips && attachedCache.audios === s.audios) return attachedCache.ids;
  const links = new Set(s.clips.map((c) => c.link).filter(Boolean));
  attachedCache.clips = s.clips;
  attachedCache.audios = s.audios;
  attachedCache.ids = new Set(s.audios.filter((a) => a.link && links.has(a.link)).map((a) => a.id));
  return attachedCache.ids;
}

/** 影片片段連結的音訊片段 */
export const linkedAudioOf = (s: { audios: AudioClip[] }, c: Clip) => (c.link ? s.audios.find((a) => a.link === c.link) : undefined);

export const useStore = create<State>()(
  persist(
    (set, get) => {
      const listOf = (type: ItemType) => get()[LIST[type]] as AnyItem[];
      const findItem = (type: ItemType, id: string) => listOf(type).find((x) => x.id === id);
      /** 目前要操作的項目：多選清單，沒有就用主選取 */
      const targets = () => {
        const s = get();
        if (s.selected.length) return s.selected.map(parseKey);
        if (s.selection && isItem(s.selection.type)) return [{ type: s.selection.type, id: s.selection.id }];
        return [];
      };

      /** 把一個片段在 t 切開，回傳 [前段, 後段] */
      const splitOne = (type: ItemType, it: AnyItem, t: number): [AnyItem, AnyItem] => {
        const local = t - it.start;
        if (type === 'clip') {
          const c = it as Clip;
          const s = get();
          const media = s.media.find((m) => m.id === c.mediaId);
          const modules = new Map(s.modules.map((m) => [m.id, m]));
          const inB = media?.kind === 'video' && !media.missing ? clipSource(c, local, media, modules).src : c.in + local;
          const [ka, kb] = splitKeys(c.keys ?? {}, local);
          const fxA: ClipFx[] = [], fxB: ClipFx[] = [];
          for (const f of c.effects ?? []) {
            const a: Record<string, Keyframe[]> = {}, b: Record<string, Keyframe[]> = {};
            for (const [p, list] of Object.entries(f.keys ?? {})) {
              const [x, y] = splitKeys({ x: list }, local);
              if (x.x) a[p] = x.x;
              if (y.x) b[p] = y.x;
            }
            fxA.push({ ...f, keys: a });
            fxB.push({ ...f, id: uid(), keys: b });
          }
          if (c.effects) {
            return [
              { ...c, duration: local, keys: ka, transitionOut: null, effects: fxA },
              { ...c, id: uid(), start: t, duration: c.duration - local, in: inB, transitionIn: null, keys: kb, effects: fxB },
            ];
          }
          return [
            { ...c, duration: local, keys: ka, transitionOut: null },
            { ...c, id: uid(), start: t, duration: c.duration - local, in: inB, transitionIn: null, keys: kb },
          ];
        }
        if (type === 'audio') {
          const a = it as AudioClip;
          return [{ ...a, duration: local, fadeOut: 0 }, { ...a, id: uid(), start: t, duration: a.duration - local, in: a.in + local * (a.rate ?? 1), fadeIn: 0 }];
        }
        const f = it as FxItem;
        if (f.keys) {
          const ka: Record<string, Keyframe[]> = {}, kb: Record<string, Keyframe[]> = {};
          for (const [p, list] of Object.entries(f.keys)) {
            const [a, b] = splitKeys({ x: list }, local);
            if (a.x) ka[p] = a.x;
            if (b.x) kb[p] = b.x;
          }
          return [{ ...f, duration: local, keys: ka }, { ...f, id: uid(), start: t, duration: f.duration - local, keys: kb }];
        }
        return [{ ...it, duration: local }, { ...it, id: uid(), start: t, duration: it.duration - local }];
      };

      const inside = (it: AnyItem, t: number) => t > it.start + 0.01 && t < it.start + it.duration - 0.01;

      /** 分割 / 修剪的對象：選取中且跨過播放頭的；沒有就用播放頭下所有影片與音訊片段 */
      const cutTargets = () => {
        const t = get().time;
        let list = targets().filter(({ type, id }) => {
          const it = findItem(type, id);
          return it && inside(it, t);
        });
        if (!list.length) {
          const s = get();
          list = [
            ...s.clips.filter((c) => inside(c, t)).map((c) => ({ type: 'clip' as const, id: c.id })),
            ...s.audios.filter((c) => inside(c, t)).map((c) => ({ type: 'audio' as const, id: c.id })),
          ];
        }
        return list;
      };

      /** 把選取擴展到同一個連結 / 群組的所有項目 */
      const expand = (keys: string[]): string[] => {
        const s = get();
        const links = new Set<string>(), groups = new Set<string>();
        for (const k of keys) {
          const { type, id } = parseKey(k);
          const it = (s[LIST[type]] as AnyItem[]).find((x) => x.id === id);
          if (it?.link) links.add(it.link);
          if (it?.group) groups.add(it.group);
        }
        if (!links.size && !groups.size) return keys;
        const out = new Set(keys);
        (['clip', 'effect', 'audio'] as ItemType[]).forEach((type) => {
          for (const it of s[LIST[type]] as AnyItem[]) {
            if ((it.link && links.has(it.link)) || (it.group && groups.has(it.group))) out.add(keyOf(type, it.id));
          }
        });
        return [...out];
      };

      /** 一批項目換上新的連結 / 群組 id（貼上、分割後的新片段不能跟原本的共用） */
      const freshIds = <T extends AnyItem>(items: T[]): T[] => {
        const map = new Map<string, string>();
        const re = (v: string | undefined) => {
          if (!v) return v;
          if (!map.has(v)) map.set(v, uid());
          return map.get(v);
        };
        return items.map((it) => (it.link || it.group ? { ...it, link: re(it.link), group: re(it.group) } : it));
      };

      const pasteItems = (items: { type: ItemType; item: AnyItem }[], base: number, at?: { track: number; kind: TrackKind }) => {
        if (!items.length) return;
        const s = get();
        const minStart = Math.min(...items.map((i) => i.item.start));
        const add: Record<string, AnyItem[]> = { clips: [], effects: [], audios: [] };
        const keys: string[] = [];
        for (const { type, item } of items) {
          const kind = KIND_OF[type];
          let track = item.track;
          if (at && items.length === 1 && at.kind === kind) track = at.track;
          track = Math.min(track, s.tracks[kind].length - 1);
          const n = { ...structuredClone(item), id: uid(), start: Math.max(0, base + (item.start - minStart)), track };
          if (type === 'clip' && (n as Clip).effects) (n as Clip).effects = (n as Clip).effects!.map((f) => ({ ...f, id: uid() }));
          add[LIST[type]].push(n);
          keys.push(keyOf(type, n.id));
        }
        // 連結 / 群組：貼上的是新的一組
        {
          const all = [...add.clips, ...add.effects, ...add.audios];
          const fresh = freshIds(all);
          const byId = new Map(fresh.map((x) => [x.id, x]));
          for (const k of Object.keys(add)) add[k] = add[k].map((x) => byId.get(x.id)!);
        }
        // 貼上的位置被佔用 → 整組往後挪到放得下的地方
        const typeOfList = { clips: 'clip', effects: 'effect', audios: 'audio' } as const;
        const moving: Span[] = [];
        for (const [list, arr] of Object.entries(add) as [keyof typeof typeOfList, AnyItem[]][]) {
          for (const it of arr) moving.push({ lane: laneOf(typeOfList[list], it.track), start: it.start, duration: it.duration });
        }
        const shift = resolveShift(moving, spansOf(s), 0, true);
        if (shift) for (const arr of Object.values(add)) for (const it of arr) it.start += shift;
        const last = parseKey(keys[keys.length - 1]);
        set({
          clips: [...s.clips, ...(add.clips as Clip[])],
          effects: [...s.effects, ...(add.effects as FxItem[])],
          audios: [...s.audios, ...(add.audios as AudioClip[])],
          selected: keys,
          selection: last,
        });
      };

      return {
        media: [],
        clips: [],
        effects: [],
        audios: [],
        tracks: DEFAULT_TRACKS,
        modules: BUILTIN_MODULES,
        selection: null,
        selected: [],
        clipboard: null,
        errors: {},
        time: 0,
        playing: false,
        loop: null,
        pps: 120,
        snap: true,
        leftTab: 'media',
        activeTrack: null,
        upperAt: 'bottom',
        setActiveTrack: (t) => set({ activeTrack: t }),
        exporting: null,
        format: DEFAULT_FORMAT,
        setFormat: (f) => set({ format: { w: Math.round(f.w), h: Math.round(f.h) } }),

        addMedia: (m) => set((s) => ({ media: [...s.media, m] })),

        addClip: (mediaId, start, trackArg, range) => {
          const s = get();
          let track = trackArg ?? (s.activeTrack?.kind === 'video' ? s.activeTrack.idx : 0);
          const media = s.media.find((m) => m.id === mediaId);
          if (!mediaUsable(media)) return;
          if (media.kind === 'audio') return s.addAudio(mediaId, start, undefined, range);
          track = Math.min(track, s.tracks.video.length - 1);
          const duration = range ? range.duration : media.kind === 'video' ? media.duration : 2; // 影片放完整長度
          const clip = makeClip({
            mediaId,
            track,
            in: range?.in ?? 0,
            start: start === undefined ? trackEnd(s.clips, track) : fitStart(spansOf(s), laneOf('clip', track), Math.max(0, start), duration),
            duration,
          });
          // 有聲音的影片：同時在音訊軌放一段連結的音訊（找一條這個時間沒被佔用的音訊軌，沒有就新增一條）
          if (media.kind === 'video' && media.hasAudio) {
            const spans = spansOf(s);
            let at = s.tracks.audio.findIndex((_, i) => Math.abs(fitStart(spans, laneOf('audio', i), clip.start, clip.duration) - clip.start) < 1e-6);
            let tracks = s.tracks;
            if (at < 0) {
              tracks = { ...s.tracks, audio: [...s.tracks.audio, {}] };
              at = tracks.audio.length - 1;
            }
            const link = uid();
            clip.link = link;
            const a = makeAudio({ mediaId, track: at, start: clip.start, duration: clip.duration, in: clip.in, link });
            return set({
              clips: [...s.clips, clip],
              audios: [...s.audios, a],
              tracks,
              selection: { type: 'clip', id: clip.id },
              selected: [keyOf('clip', clip.id), keyOf('audio', a.id)],
              leftTab: 'editor',
            });
          }
          set({ clips: [...s.clips, clip], selection: { type: 'clip', id: clip.id }, selected: [keyOf('clip', clip.id)], leftTab: 'editor' });
        },

        addAudio: (mediaId, start, trackArg, range) => {
          if (!get().tracks.audio.length) get().addTrack('audio');
          const s = get();
          let track = trackArg ?? (s.activeTrack?.kind === 'audio' ? s.activeTrack.idx : 0);
          const media = s.media.find((m) => m.id === mediaId);
          if (!mediaUsable(media) || !media.hasAudio) return;
          track = Math.min(track, s.tracks.audio.length - 1);
          const dur = range ? range.duration : media.duration;
          const a = makeAudio({
            mediaId,
            track,
            in: range?.in ?? 0,
            start: start === undefined ? trackEnd(s.audios, track) : fitStart(spansOf(s), laneOf('audio', track), Math.max(0, start), dur),
            duration: dur,
          });
          set({ audios: [...s.audios, a], selection: { type: 'audio', id: a.id }, selected: [keyOf('audio', a.id)], leftTab: 'editor' });
        },

        updateClip: (id, patch) => set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
        updateAudio: (id, patch) => set((s) => ({ audios: s.audios.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),

        patchItems: (patches) =>
          set((s) => {
            const apply = <T extends AnyItem>(type: ItemType, list: T[]) =>
              list.map((x) => {
                const p = patches[keyOf(type, x.id)];
                return p ? ({ ...x, ...p } as T) : x;
              });
            return { clips: apply('clip', s.clips), effects: apply('effect', s.effects), audios: apply('audio', s.audios) };
          }),

        setTransition: (clipId, moduleId, side = 'in') =>
          set((s) => {
            const f = side === 'out' ? 'transitionOut' : 'transitionIn';
            return {
              clips: s.clips.map((c) => {
                if (c.id !== clipId) return c;
                const cur = c[f];
                return { ...c, [f]: moduleId ? { moduleId, params: cur?.moduleId === moduleId ? cur.params : {}, duration: cur?.duration ?? 0.4 } : null };
              }),
              selection: moduleId ? { type: 'transition', id: trSelId(clipId, side) } : { type: 'clip', id: clipId },
              selected: moduleId ? [] : [keyOf('clip', clipId)],
              leftTab: 'editor',
            };
          }),

        updateTransition: (clipId, patch, side = 'in') =>
          set((s) => {
            const f = side === 'out' ? 'transitionOut' : 'transitionIn';
            return { clips: s.clips.map((c) => (c.id === clipId && c[f] ? { ...c, [f]: { ...c[f]!, ...patch } } : c)) };
          }),

        applyTransitions: (track, scope, tpl) => {
          const s = get();
          const sorted = s.clips.filter((c) => c.track === track).sort((a, b) => a.start - b.start);
          const ref = (): TransitionRef => ({ moduleId: tpl.moduleId, params: { ...(tpl.params ?? {}) }, duration: tpl.duration ?? 0.4 });
          const patch = new Map<string, Partial<Clip>>();
          const adj = (a: Clip | undefined, b: Clip | undefined) => !!a && !!b && Math.abs(a.start + a.duration - b.start) <= 0.01;
          sorted.forEach((c, i) => {
            const p: Partial<Clip> = {};
            const hasPrev = adj(sorted[i - 1], c);
            const hasNext = adj(c, sorted[i + 1]);
            if ((scope === 'cuts' || scope === 'all') && hasPrev) p.transitionIn = ref();
            if ((scope === 'heads' || scope === 'all') && !hasPrev) p.transitionIn = ref();
            if ((scope === 'tails' || scope === 'all') && !hasNext) p.transitionOut = ref();
            if (Object.keys(p).length) patch.set(c.id, p);
          });
          if (patch.size) set({ clips: s.clips.map((c) => (patch.has(c.id) ? { ...c, ...patch.get(c.id) } : c)) });
          return patch.size;
        },

        trackForInsert: (kind, start, duration) => {
          if (!get().tracks[kind].length) get().addTrack(kind);
          const s = get();
          const n = s.tracks[kind].length;
          const at = s.activeTrack?.kind === kind ? Math.min(s.activeTrack.idx, n - 1) : kind === 'video' ? n - 1 : 0;
          const lane = `${kind}:${at}`;
          const spans = spansOf(s);
          if (Math.abs(fitStart(spans, lane, start, duration) - start) < 1e-6) return at;
          // 被佔用：在旁邊新增一條（影片 / 特效 = 上一層；音訊 = 下面一條）
          s.addTrack(kind, at + 1);
          set({ activeTrack: { kind, idx: at + 1 } });
          return at + 1;
        },

        setRemap: (clipId, moduleId) =>
          set((s) => ({
            clips: s.clips.map((c) => (c.id === clipId ? { ...c, remap: { moduleId, params: {} } } : c)),
            selection: { type: 'clip', id: clipId },
            selected: [keyOf('clip', clipId)],
            leftTab: 'editor',
          })),

        addEffect: (moduleId, start, trackArg) => {
          if (!get().tracks.fx.length) get().addTrack('fx');
          const s = get();
          let track = trackArg ?? (s.activeTrack?.kind === 'fx' ? s.activeTrack.idx : 0);
          const m = s.modules.find((x) => x.id === moduleId);
          if (!m) return;
          track = Math.max(0, Math.min(track, s.tracks.fx.length - 1));
          const duration = parseDuration(m.code, 0.5);
          const fx: FxItem = { id: uid(), moduleId, params: {}, start: fitStart(spansOf(s), laneOf('effect', track), Math.max(0, start), duration), duration, track };
          set({ effects: [...s.effects, fx], selection: { type: 'effect', id: fx.id }, selected: [keyOf('effect', fx.id)], leftTab: 'editor' });
        },

        addText: (presetId, start, track) => {
          const s = get();
          const p = TEXT_PRESETS.find((x) => x.id === presetId) ?? TEXT_PRESETS[0];
          // 預設放在最上面的影片軌
          const tk = Math.max(0, Math.min(track ?? s.tracks.video.length - 1, s.tracks.video.length - 1));
          const t0 = Math.max(0, start ?? s.time);
          const clip = makeClip({
            mediaId: '',
            track: tk,
            start: fitStart(spansOf(s), laneOf('clip', tk), t0, p.duration),
            duration: p.duration,
            fit: 'contain',
            text: { ...DEFAULT_TEXT, ...p.style },
            transform: { ...DEFAULT_TRANSFORM, y: p.y },
          });
          set({ clips: [...s.clips, clip], selection: { type: 'clip', id: clip.id }, selected: [keyOf('clip', clip.id)], leftTab: 'editor' });
        },

        updateEffect: (id, patch) => set((s) => ({ effects: s.effects.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),

        replaceEffect: (id, moduleId) =>
          set((s) => ({
            effects: s.effects.map((e) => {
              if (e.id !== id) return e;
              const keys: Record<string, Keyframe[]> = {};
              for (const [k, v] of Object.entries(e.keys ?? {})) if (k.startsWith('mask.')) keys[k] = v;
              return { ...e, moduleId, params: {}, keys };
            }),
            selection: { type: 'effect', id },
            selected: [keyOf('effect', id)],
            leftTab: 'editor',
          })),

        relinkMedia: (oldId, newId) =>
          set((s) => ({
            clips: s.clips.map((c) => (c.mediaId === oldId ? { ...c, mediaId: newId } : c)),
            audios: s.audios.map((a) => (a.mediaId === oldId ? { ...a, mediaId: newId } : a)),
            media: s.media.filter((m) => !(m.id === oldId && m.missing)),
          })),

        removeSelection: (ripple = false) => {
          const s = get();
          const sel = s.selection;
          if (sel?.type === 'transition') {
            const { clipId, side } = parseTrSel(sel.id);
            return s.setTransition(clipId, null, side);
          }
          if (sel?.type === 'module') {
            if (s.removeModule(sel.id)) set({ selection: null });
            return;
          }
          const dels = targets()
            .map(({ type, id }) => ({ type, it: findItem(type, id) }))
            .filter((d): d is { type: ItemType; it: AnyItem } => !!d.it)
            .sort((a, b) => b.it.start - a.it.start); // 從後面刪，波紋位移才不會互相干擾
          if (!dels.length) return void get().removeGap();
          const lists: Record<string, AnyItem[]> = { clips: s.clips, effects: s.effects, audios: s.audios };
          if (ripple === 'all') {
            const gone = new Set(dels.map((d) => keyOf(d.type, d.it.id)));
            for (const t of ['clip', 'effect', 'audio'] as ItemType[]) lists[LIST[t]] = lists[LIST[t]].filter((x) => !gone.has(keyOf(t, x.id)));
            // 刪掉的時間範圍取聯集，從後面往前處理
            const ranges = dels.map((d) => [d.it.start, d.it.start + d.it.duration]).sort((a, b) => a[0] - b[0]);
            const merged: number[][] = [];
            for (const r of ranges) {
              const last = merged[merged.length - 1];
              if (last && r[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], r[1]);
              else merged.push([...r]);
            }
            for (const [a, b] of merged.reverse()) {
              const attached = attachedAudioIds({ clips: lists.clips as Clip[], audios: lists.audios as AudioClip[] });
              const lanes = new Map<string, number>(); // 每條軌最多能往前推多少
              for (const t of ['clip', 'effect', 'audio'] as ItemType[]) {
                for (const x of lists[LIST[t]]) {
                  if (t === 'audio' && attached.has(x.id)) continue;
                  const lane = `${KIND_OF[t]}:${x.track}`;
                  if (!lanes.has(lane)) lanes.set(lane, b - a);
                  // 留在原地、但結尾超過 a 的項目會擋住後面的東西
                  if (x.start < b - 1e-3 && x.start + x.duration > a) lanes.set(lane, Math.min(lanes.get(lane)!, Math.max(0, b - (x.start + x.duration))));
                }
              }
              for (const t of ['clip', 'effect', 'audio'] as ItemType[]) {
                lists[LIST[t]] = lists[LIST[t]].map((x) => {
                  if (t === 'audio' && attached.has(x.id)) return x; // 連結音訊跟著影片同步
                  const d = lanes.get(`${KIND_OF[t]}:${x.track}`) ?? 0;
                  return d > 1e-6 && x.start >= b - 1e-3 ? { ...x, start: Math.max(0, x.start - d) } : x;
                });
              }
            }
          } else {
            for (const { type, it } of dels) {
              const key = LIST[type];
              const end = it.start + it.duration;
              let l = lists[key].filter((x) => x.id !== it.id);
              if (ripple) l = l.map((x) => (x.track === it.track && x.start >= end - 1e-3 ? { ...x, start: Math.max(0, x.start - it.duration) } : x));
              lists[key] = l;
            }
          }
          set({ clips: lists.clips as Clip[], effects: lists.effects as FxItem[], audios: lists.audios as AudioClip[], selection: null, selected: [] });
        },

        removeGap: () => {
          const s = get();
          const at = s.activeTrack;
          if (!at) return false;
          const lane = `${at.kind}:${at.idx}`;
          const spans = spansOf(s).filter((x) => x.lane === lane);
          const t = s.time;
          if (spans.some((x) => t >= x.start - 1e-6 && t < x.start + x.duration - 1e-6)) return false;
          const prevEnd = Math.max(0, ...spans.filter((x) => x.start + x.duration <= t + 1e-6).map((x) => x.start + x.duration));
          const after = spans.filter((x) => x.start >= t - 1e-6);
          if (!after.length) return false;
          const nextStart = Math.min(...after.map((x) => x.start));
          const gap = nextStart - prevEnd;
          if (gap < 1e-6) return false;
          const attached = attachedAudioIds(s);
          const patches: Record<string, Partial<AnyItem>> = {};
          (['clip', 'effect', 'audio'] as ItemType[]).forEach((type) => {
            if (KIND_OF[type] !== at.kind) return;
            for (const it of s[LIST[type]] as AnyItem[]) {
              if (it.track !== at.idx || it.start < nextStart - 1e-6 || (type === 'audio' && attached.has(it.id))) continue;
              patches[keyOf(type, it.id)] = { start: Math.max(0, it.start - gap) };
            }
          });
          s.patchItems(patches);
          s.setTime(prevEnd);
          return true;
        },

        split: () => {
          const t = get().time;
          const list = cutTargets();
          if (!list.length) return;
          const s = get();
          const lists: Record<string, AnyItem[]> = { clips: s.clips, effects: s.effects, audios: s.audios };
          const newKeys: string[] = [];
          const backs: AnyItem[] = [];
          for (const { type, id } of list) {
            const key = LIST[type];
            const it = lists[key].find((x) => x.id === id)!;
            const [a, b] = splitOne(type, it, t);
            backs.push(b);
            lists[key] = lists[key].flatMap((x) => (x.id === id ? [a, b] : [x]));
            newKeys.push(keyOf(type, b.id));
          }
          // 後半段是新的一組連結 / 群組（跟前半段分開）
          const fresh = new Map(freshIds(backs).map((x) => [x.id, x]));
          for (const k of Object.keys(lists)) lists[k] = lists[k].map((x) => fresh.get(x.id) ?? x);
          const last = parseKey(newKeys[newKeys.length - 1]);
          set({ clips: lists.clips as Clip[], effects: lists.effects as FxItem[], audios: lists.audios as AudioClip[], selected: newKeys, selection: last });
        },

        trim: (side) => {
          const t = get().time;
          const list = cutTargets();
          if (!list.length) return;
          const s = get();
          const lists: Record<string, AnyItem[]> = { clips: s.clips, effects: s.effects, audios: s.audios };
          for (const { type, id } of list) {
            const key = LIST[type];
            const it = lists[key].find((x) => x.id === id)!;
            const [a, b] = splitOne(type, it, t);
            const keep = side === 'start' ? { ...b, id: it.id } : a; // 修掉播放頭前（Q）或後（W）
            lists[key] = lists[key].map((x) => (x.id === id ? keep : x));
          }
          set({ clips: lists.clips as Clip[], effects: lists.effects as FxItem[], audios: lists.audios as AudioClip[] });
        },

        nudge: (dt) => {
          const list = targets();
          if (!list.length) return;
          const s = get();
          const keys = new Set(list.map(({ type, id }) => keyOf(type, id)));
          const moving: Span[] = [];
          const patches: Record<string, Partial<AnyItem>> = {};
          for (const { type, id } of list) {
            const it = findItem(type, id);
            if (!it) continue;
            moving.push({ lane: laneOf(type, it.track), start: it.start, duration: it.duration });
            patches[keyOf(type, id)] = { start: it.start + dt };
          }
          // 會撞到別的片段或跑到 0 之前就不動
          if (!moving.length || !groupFits(moving, spansOf(s, keys), dt)) return;
          get().patchItems(patches);
        },

        copy: () => {
          const items = targets()
            .map(({ type, id }) => ({ type, item: findItem(type, id) }))
            .filter((x): x is { type: ItemType; item: AnyItem } => !!x.item)
            .map((x) => ({ type: x.type, item: structuredClone(x.item) }));
          if (items.length) set({ clipboard: { items } });
        },

        cut: () => {
          get().copy();
          get().removeSelection();
        },

        paste: (at) => {
          const cb = get().clipboard;
          if (cb) pasteItems(cb.items, at?.time ?? get().time, at);
        },

        duplicate: () => {
          const items = targets()
            .map(({ type, id }) => ({ type, item: findItem(type, id) }))
            .filter((x): x is { type: ItemType; item: AnyItem } => !!x.item);
          if (!items.length) return;
          const end = Math.max(...items.map((i) => i.item.start + i.item.duration));
          pasteItems(items, end);
        },

        addTrack: (kind, at, level, row) =>
          set((s) => {
            const n = s.tracks[kind].length;
            const i = Math.max(0, Math.min(n, at ?? n));
            const act = s.activeTrack?.kind === kind && s.activeTrack.idx >= i ? { kind, idx: s.activeTrack.idx + 1 } : s.activeTrack;
            const list = [...s.tracks[kind]];
            list.splice(i, 0, {});
            const shift = <T extends AnyItem>(items: T[]) => items.map((x) => (x.track >= i ? { ...x, track: x.track + 1 } : x));
            let fx = kind === 'fx' ? list : s.tracks.fx;
            // 新增影片軌：在它上方（level >= i）的特效軌 level + 1，維持原本的上下關係
            if (kind === 'video') fx = fx.map((t, j) => ({ ...t, level: fxLevel(s.tracks, j) >= i ? fxLevel(s.tracks, j) + 1 : fxLevel(s.tracks, j) }));
            // 新增特效軌：跟它下面那條特效軌同一層（沒有的話放最上層）
            if (kind === 'fx') {
              const ref = level ?? (i > 0 ? fxLevel(s.tracks, i - 1) : s.tracks.fx.length ? fxLevel(s.tracks, 0) : s.tracks.video.length);
              fx = fx.map((t, j) => (j === i ? { ...t, level: ref } : t));
            }
            const next: Tracks = { ...s.tracks, [kind]: list, fx };
            if (kind === 'audio') {
              // 新音訊軌顯示在哪：row（上面有幾條影片 / 特效軌）；沒給 = 所有軌道的最下面
              next.audio = list.map((t, j) => (j === i ? (row !== undefined ? { row } : {}) : t));
            } else {
              // 新的影片 / 特效軌插進顯示順序後，音訊軌維持在原本的相對位置
              const L0 = visualRows(s.tracks).length;
              const disp = s.upperAt === 'top' ? visualRows(next) : [...visualRows(next)].reverse();
              const q = disp.findIndex((x) => x.kind === kind && x.idx === i);
              next.audio = s.tracks.audio.map((t) => {
                const r0 = Math.min(L0, t.row ?? L0);
                return { ...t, row: r0 > q || (r0 === q && q < L0) ? r0 + 1 : r0 };
              });
            }
            return {
              activeTrack: act,
              tracks: next,
              ...(kind === 'video' ? { clips: shift(s.clips) } : kind === 'fx' ? { effects: shift(s.effects) } : { audios: shift(s.audios) }),
            };
          }),

        moveTrack: (kind, from, to) =>
          set((s) => {
            const n = s.tracks[kind].length;
            if (from === to || from < 0 || to < 0 || from >= n || to >= n) return {};
            const order = [...Array(n).keys()];
            order.splice(from, 1);
            order.splice(to, 0, from);
            const newIdx = new Map(order.map((old, i) => [old, i]));
            const remap = <T extends AnyItem>(items: T[]) => items.map((x) => ({ ...x, track: newIdx.get(x.track) ?? x.track }));
            return {
              activeTrack: s.activeTrack?.kind === kind ? { kind, idx: newIdx.get(s.activeTrack.idx) ?? s.activeTrack.idx } : s.activeTrack,
              tracks: { ...s.tracks, [kind]: order.map((o) => s.tracks[kind][o]) },
              ...(kind === 'video' ? { clips: remap(s.clips) } : kind === 'fx' ? { effects: remap(s.effects) } : { audios: remap(s.audios) }),
            };
          }),

        reorderTracks: (order) =>
          set((s) => {
            const all = displayRows(s.tracks, s.upperAt);
            if (order.length !== all.length) return {};
            const { tracks, maps } = tracksFromOrder(s.tracks, order, s.upperAt);
            const remap = <T extends AnyItem>(items: T[], kind: TrackKind) => items.map((x) => {
              const n = maps[kind].get(x.track);
              return n === undefined || n === x.track ? x : { ...x, track: n };
            });
            const act = s.activeTrack;
            return {
              tracks,
              clips: remap(s.clips, 'video'),
              effects: remap(s.effects, 'fx'),
              audios: remap(s.audios, 'audio'),
              activeTrack: act ? { kind: act.kind, idx: maps[act.kind].get(act.idx) ?? act.idx } : act,
            };
          }),

        trackItemCount: (kind, idx) => {
          const s = get();
          const attached = attachedAudioIds(s);
          const list = kind === 'video' ? s.clips : kind === 'fx' ? s.effects : s.audios.filter((a) => !attached.has(a.id));
          return list.filter((x) => x.track === idx).length;
        },

        deleteTrack: (kind, idx) => {
          const s = get();
          if (idx < 0 || idx >= s.tracks[kind].length) return false;
          if (kind === 'video' && s.tracks.video.length <= 1) return false;
          const attached = attachedAudioIds(s);
          // 這條軌道上的項目一起刪掉；刪影片時連結的音訊也一起刪
          const goneClips = kind === 'video' ? s.clips.filter((c) => c.track === idx) : [];
          const goneLinks = new Set(goneClips.map((c) => c.link).filter(Boolean));
          const keepAudio = (a: AudioClip) => !(a.link && goneLinks.has(a.link)) && !(kind === 'audio' && a.track === idx && !attached.has(a.id));
          const shift = <T extends AnyItem>(items: T[]) => items.map((x) => (x.track > idx ? { ...x, track: x.track - 1 } : x));
          let clips = s.clips, effects = s.effects;
          let audios = s.audios.filter(keepAudio);
          if (kind === 'video') clips = shift(s.clips.filter((c) => c.track !== idx));
          if (kind === 'fx') effects = shift(s.effects.filter((e) => e.track !== idx));
          // 連結在影片上的音訊（看不到）在被刪的音訊軌上：換到第一條，軌道 index 往前補
          if (kind === 'audio') audios = audios.map((a) => (a.track === idx ? { ...a, track: 0 } : a.track > idx ? { ...a, track: a.track - 1 } : a));
          const tracks = { ...s.tracks, [kind]: s.tracks[kind].filter((_, i) => i !== idx) };
          if (kind !== 'audio') {
            const L0 = visualRows(s.tracks).length;
            const disp = s.upperAt === 'top' ? visualRows(s.tracks) : [...visualRows(s.tracks)].reverse();
            const q = disp.findIndex((x) => x.kind === kind && x.idx === idx);
            tracks.audio = s.tracks.audio.map((t) => {
              const r0 = Math.min(L0, t.row ?? L0);
              return t.row === undefined ? t : { ...t, row: r0 > q ? r0 - 1 : r0 };
            });
          }
          if (kind === 'video') tracks.fx = s.tracks.fx.map((t, j) => ({ ...t, level: fxLevel(s.tracks, j) > idx ? fxLevel(s.tracks, j) - 1 : fxLevel(s.tracks, j) }));
          const act = s.activeTrack;
          const ids = new Set([...clips, ...effects, ...audios].map((x) => x.id));
          set({
            tracks,
            clips,
            effects,
            audios,
            activeTrack: act?.kind === kind ? (act.idx === idx ? null : act.idx > idx ? { kind, idx: act.idx - 1 } : act) : act,
            selected: s.selected.filter((k) => ids.has(parseKey(k).id)),
            selection: s.selection && isItem(s.selection.type) && !ids.has(s.selection.id) ? null : s.selection,
          });
          return true;
        },
        toggleTrack: (kind, idx, key) =>
          set((s) => ({ tracks: { ...s.tracks, [kind]: s.tracks[kind].map((t, i) => (i === idx ? { ...t, [key]: !t[key] } : t)) } })),
        setTrackHeight: (kind, idx, h) =>
          set((s) => ({
            tracks: { ...s.tracks, [kind]: s.tracks[kind].map((t, i) => (i === idx ? { ...t, height: h === undefined ? undefined : Math.round(Math.min(240, Math.max(22, h))) } : t)) },
          })),
        setFxLevel: (idx, level) =>
          set((s) => ({
            tracks: { ...s.tracks, fx: s.tracks.fx.map((t, i) => (i === idx ? { ...t, level: Math.max(0, Math.min(s.tracks.video.length, level)) } : t)) },
          })),

        select: (sel, mode = 'replace') => {
          if (!sel) return set({ selection: null, selected: [] });
          if (!isItem(sel.type)) return set({ selection: sel, selected: [], leftTab: 'editor' });
          const s = get();
          const key = keyOf(sel.type, sel.id);
          const family = expand([key]);
          if (mode === 'toggle') {
            if (s.selected.includes(key)) {
              const rest = s.selected.filter((k) => !family.includes(k));
              return set({ selected: rest, selection: rest.length ? parseKey(rest[rest.length - 1]) : null });
            }
            return set({ selected: Array.from(new Set([...s.selected, ...family])), selection: sel, leftTab: 'editor' });
          }
          if (mode === 'range' && s.selection && s.selection.type === sel.type) {
            const anchor = findItem(sel.type, s.selection.id);
            const target = findItem(sel.type, sel.id);
            if (anchor && target && anchor.track === target.track) {
              const lo = Math.min(anchor.start, target.start);
              const hi = Math.max(anchor.start, target.start);
              const keys = listOf(sel.type)
                .filter((x) => x.track === anchor.track && x.start >= lo - 1e-6 && x.start <= hi + 1e-6)
                .map((x) => keyOf(sel.type as ItemType, x.id));
              // 保留主選取為 anchor，讓之後 shift 點擊仍以它為起點
              return set({ selected: expand(keys), leftTab: 'editor' });
            }
          }
          set({ selection: sel, selected: family, leftTab: 'editor' });
        },

        selectKeys: (keys, additive = false) => {
          const s = get();
          const all = expand(additive ? Array.from(new Set([...s.selected, ...keys])) : keys);
          set({ selected: all, selection: all.length ? parseKey(all[all.length - 1]) : null });
        },

        selectAll: () => {
          const s = get();
          const keys = [
            ...s.clips.map((c) => keyOf('clip', c.id)),
            ...s.effects.map((c) => keyOf('effect', c.id)),
            ...s.audios.map((c) => keyOf('audio', c.id)),
          ];
          set({ selected: keys, selection: keys.length ? parseKey(keys[0]) : null });
        },

        addClipFx: (clipId, moduleId) =>
          set((s) => ({
            clips: s.clips.map((c) => (c.id === clipId ? { ...c, effects: [...(c.effects ?? []), { id: uid(), moduleId, params: {} }] } : c)),
            selection: { type: 'clip', id: clipId },
            leftTab: 'editor',
          })),
        updateClipFx: (clipId, fxId, patch) =>
          set((s) => ({
            clips: s.clips.map((c) => (c.id === clipId ? { ...c, effects: (c.effects ?? []).map((f) => (f.id === fxId ? { ...f, ...patch } : f)) } : c)),
          })),
        removeClipFx: (clipId, fxId) =>
          set((s) => ({
            clips: s.clips.map((c) => (c.id === clipId ? { ...c, effects: (c.effects ?? []).filter((f) => f.id !== fxId) } : c)),
          })),
        moveClipFx: (clipId, fxId, dir) =>
          set((s) => ({
            clips: s.clips.map((c) => {
              if (c.id !== clipId || !c.effects) return c;
              const l = [...c.effects];
              const i = l.findIndex((f) => f.id === fxId);
              const j = i + dir;
              if (i < 0 || j < 0 || j >= l.length) return c;
              [l[i], l[j]] = [l[j], l[i]];
              return { ...c, effects: l };
            }),
          })),

        renameItem: (type, id, name) => {
          const n = name.trim() || undefined;
          get().patchItems({ [keyOf(type, id)]: { name: n } });
        },

        linkSelected: () => {
          const s = get();
          const list = targets();
          if (!list.some((x) => x.type === 'clip') || !list.some((x) => x.type === 'audio')) return false;
          const id = uid();
          const patches: Record<string, Partial<AnyItem>> = {};
          for (const { type, id: iid } of list) if (type !== 'effect') patches[keyOf(type, iid)] = type === 'clip' ? { link: id, audioSplit: undefined } : { link: id };
          s.patchItems(patches);
          return true;
        },

        unlinkSelected: () => {
          const before = get();
          // 先記下每段音訊原本連結的影片在哪條軌道
          const clipTrackOf = new Map<string, number>();
          for (const { type, id } of targets()) {
            if (type !== 'audio') continue;
            const a = before.audios.find((x) => x.id === id);
            const c = a?.link ? before.clips.find((x) => x.link === a.link) : undefined;
            if (a && c) clipTrackOf.set(a.id, c.track);
          }
          const patches: Record<string, Partial<AnyItem>> = {};
          for (const { type, id } of targets()) {
            // 影片原本的聲音由連結音訊負責 → 分開後影片本身要靜音，不然會跟獨立出來的音訊重複
            const c = type === 'clip' ? before.clips.find((x) => x.id === id) : undefined;
            const hadAudio = !!c?.link && before.audios.some((a) => a.link === c.link);
            patches[keyOf(type, id)] = hadAudio ? { link: undefined, volume: 0, audioSplit: true } : { link: undefined };
          }
          get().patchItems(patches);
          // 分開後：影片軌的下一條是音訊軌而且有空位 → 放進去；否則在影片軌正下方新增一條音訊軌
          for (const [aid, vt] of clipTrackOf) {
            const st = get();
            const a = st.audios.find((x) => x.id === aid);
            if (!a) continue;
            const rows = displayRows(st.tracks, st.upperAt);
            const p = rows.findIndex((x) => x.kind === 'video' && x.idx === vt);
            const next = rows[p + 1];
            const spans = spansOf(st, new Set([keyOf('audio', a.id)]));
            if (next?.kind === 'audio' && Math.abs(fitStart(spans, laneOf('audio', next.idx), a.start, a.duration) - a.start) < 1e-6) {
              get().patchItems({ [keyOf('audio', a.id)]: { track: next.idx } });
              continue;
            }
            const rowVal = rows.slice(0, p + 1).filter((x) => x.kind !== 'audio').length;
            st.addTrack('audio', 0, undefined, rowVal);
            get().patchItems({ [keyOf('audio', a.id)]: { track: 0 } });
          }
          // 取消後只保留主選取
          const sel = get().selection;
          if (sel && isItem(sel.type)) set({ selected: [keyOf(sel.type, sel.id)] });
        },

        groupSelected: () => {
          const list = targets();
          if (list.length < 2) return false;
          const id = uid();
          const patches: Record<string, Partial<AnyItem>> = {};
          for (const { type, id: iid } of list) patches[keyOf(type, iid)] = { group: id };
          get().patchItems(patches);
          return true;
        },

        ungroupSelected: () => {
          const patches: Record<string, Partial<AnyItem>> = {};
          for (const { type, id } of targets()) patches[keyOf(type, id)] = { group: undefined };
          get().patchItems(patches);
        },

        mergeSelected: () => {
          const s = get();
          const modules = new Map(s.modules.map((m) => [m.id, m]));
          const sel = new Set(targets().map(({ type, id }) => keyOf(type, id)));
          let merged = 0;
          const out: Record<string, AnyItem[]> = { clips: s.clips, effects: s.effects, audios: s.audios };
          const EPS = 0.02;
          (['clip', 'effect', 'audio'] as ItemType[]).forEach((type) => {
            const key = LIST[type];
            let list = [...(out[key] as AnyItem[])];
            const picked = list.filter((x) => sel.has(keyOf(type, x.id))).sort((a, b) => a.track - b.track || a.start - b.start);
            for (let i = 0; i < picked.length - 1; i++) {
              const A = list.find((x) => x.id === picked[i].id)!;
              const B = picked[i + 1];
              if (A.track !== B.track || Math.abs(A.start + A.duration - B.start) > EPS) continue;
              let joined: AnyItem | null = null;
              if (type === 'clip') {
                const a = A as Clip, b = B as Clip;
                const sp = plainSpeed(a, modules);
                const sameSrc = a.mediaId === b.mediaId && !a.text && !b.text && JSON.stringify(a.remap) === JSON.stringify(b.remap) && (a.rate ?? 1) === (b.rate ?? 1);
                const contiguous = sp !== null && Math.abs(a.in + a.duration * sp - b.in) < 0.05;
                const sameFx = (a.effects ?? []).map((f) => f.moduleId).join() === (b.effects ?? []).map((f) => f.moduleId).join();
                if (!sameSrc || !contiguous || b.transitionIn || !sameFx) continue;
                const keys: Keys = {};
                for (const { prop } of ANIM_PROPS) {
                  const ka = a.keys[prop], kb = b.keys[prop];
                  if (ka?.length || kb?.length) keys[prop] = [...(ka ?? []), ...(kb ?? []).map((k) => ({ ...k, t: k.t + a.duration }))];
                }
                const effects = a.effects?.map((f, i) => {
                  const g = b.effects![i];
                  const k: Record<string, Keyframe[]> = {};
                  for (const p of new Set([...Object.keys(f.keys ?? {}), ...Object.keys(g.keys ?? {})])) {
                    k[p] = [...(f.keys?.[p] ?? []), ...(g.keys?.[p] ?? []).map((x) => ({ ...x, t: x.t + a.duration }))];
                  }
                  return { ...f, keys: k };
                });
                joined = { ...a, duration: a.duration + b.duration, keys, transitionOut: b.transitionOut ?? null, effects };
              } else if (type === 'audio') {
                const a = A as AudioClip, b = B as AudioClip;
                if (a.mediaId !== b.mediaId || (a.rate ?? 1) !== (b.rate ?? 1) || Math.abs(a.in + a.duration * (a.rate ?? 1) - b.in) > 0.05) continue;
                joined = { ...a, duration: a.duration + b.duration, fadeOut: b.fadeOut };
              } else {
                const a = A as FxItem, b = B as FxItem;
                if (a.moduleId !== b.moduleId || JSON.stringify(a.params) !== JSON.stringify(b.params)) continue;
                const keys: Record<string, Keyframe[]> = {};
                for (const k of new Set([...Object.keys(a.keys ?? {}), ...Object.keys(b.keys ?? {})])) {
                  keys[k] = [...(a.keys?.[k] ?? []), ...(b.keys?.[k] ?? []).map((x) => ({ ...x, t: x.t + a.duration }))];
                }
                joined = { ...a, duration: a.duration + b.duration, keys };
              }
              list = list.filter((x) => x.id !== B.id).map((x) => (x.id === A.id ? joined! : x));
              picked[i + 1] = joined!;
              merged++;
            }
            out[key] = list;
          });
          if (merged) {
            const ids = new Set([...out.clips, ...out.effects, ...out.audios].map((x) => x.id));
            const keep = get().selected.filter((k) => ids.has(parseKey(k).id));
            set({ clips: out.clips as Clip[], effects: out.effects as FxItem[], audios: out.audios as AudioClip[], selected: keep, selection: keep.length ? parseKey(keep[0]) : null });
          }
          return merged;
        },

        updateModuleCode: (id, code) => set((s) => ({ modules: s.modules.map((m) => (m.id === id ? { ...m, code } : m)) })),
        renameModule: (id, name) => set((s) => ({ modules: s.modules.map((m) => (m.id === id ? { ...m, name } : m)) })),

        forkModule: (id) => {
          const m = get().modules.find((x) => x.id === id);
          if (!m) return id;
          const copy: Module = { id: `${m.kind}-${uid()}`, kind: m.kind, name: $t('{0}（副本）', m.name), code: m.code };
          set((s) => ({ modules: [...s.modules, copy] }));
          return copy.id;
        },

        resetModule: (id) => {
          const b = BUILTIN_MODULES.find((x) => x.id === id);
          if (b) set((s) => ({ modules: s.modules.map((m) => (m.id === id ? { ...b } : m)) }));
        },

        createModule: (kind, init) => {
          const names = { effect: $t('新特效'), transition: $t('新轉場'), remap: $t('新變速') };
          const m: Module = { id: `${kind}-${uid()}`, kind, name: init?.name || names[kind], code: init?.code ?? NEW_MODULE_TEMPLATES[kind] };
          set((s) => ({ modules: [...s.modules, m] }));
          return m.id;
        },

        removeModule: (id) => {
          const s = get();
          const m = s.modules.find((x) => x.id === id);
          const used =
            s.clips.some((c) => c.remap.moduleId === id || c.transitionIn?.moduleId === id || c.transitionOut?.moduleId === id || !!c.effects?.some((f) => f.moduleId === id)) || s.effects.some((e) => e.moduleId === id);
          if (!m || m.builtin || used) return false;
          set({ modules: s.modules.filter((x) => x.id !== id) });
          return true;
        },

        setError: (id, msg) => {
          if ((get().errors[id] ?? null) === msg) return;
          set((s) => ({ errors: { ...s.errors, [id]: msg } }));
        },

        setTime: (t) => set({ time: Math.max(0, t) }),
        setPlaying: (p) => set({ playing: p }),
        togglePlay: () => {
          const s = get();
          if (!s.playing && !s.loop && s.time >= projectDuration(s) - 1e-3) set({ time: 0 });
          set({ playing: !s.playing });
        },
        setLoop: (l) => set(l ? { loop: l, time: l.a, playing: true } : { loop: null }),
        setPps: (p) => set({ pps: Math.min(800, Math.max(5, p)) }),
        setSnap: (snap) => set({ snap }),
        setLeftTab: (t) => set({ leftTab: t }),
      };
    },
    {
      name: 'ybeat-modules',
      version: 1,
      // 模組（你寫的程式碼）存在 localStorage；專案與素材另外存在 IndexedDB（見 engine/project.ts）
      partialize: (s) => ({ modules: s.modules }),
      merge: (persisted, current) => {
        const saved: Module[] = (persisted as { modules?: Module[] })?.modules ?? [];
        const byId = new Map(saved.map((m) => [m.id, m]));
        // 存檔裡的內建模組程式碼（可能被使用者改過）只在版本相同時沿用
        const modules = BUILTIN_MODULES.map((b) => {
          const m = byId.get(b.id);
          return m && (m.rev ?? 1) === (b.rev ?? 1) ? { ...b, code: m.code } : b;
        });
        for (const m of saved) if (!BUILTIN_MODULES.some((b) => b.id === m.id)) modules.push(m);
        return { ...current, modules };
      },
    },
  ),
);

// ───────────────────────── 影音連結：一邊改了，另一邊跟著改 ─────────────────────────

let syncing = false;
useStore.subscribe((s, p) => {
  if (syncing || (s.clips === p.clips && s.audios === p.audios)) return;
  const prevClips = new Map(p.clips.map((c) => [c.id, c]));
  const prevAudios = new Map(p.audios.map((a) => [a.id, a]));
  const audioByLink = new Map<string, AudioClip>();
  for (const a of s.audios) if (a.link) audioByLink.set(a.link, a);
  const clipByLink = new Map<string, Clip>();
  for (const c of s.clips) if (c.link) clipByLink.set(c.link, c);
  const modules = new Map(s.modules.map((m) => [m.id, m]));
  const aPatch = new Map<string, Partial<AudioClip>>();
  const cPatch = new Map<string, Partial<Clip>>();
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
  for (const c of s.clips) {
    if (!c.link || prevClips.get(c.id) === c) continue;
    const a = audioByLink.get(c.link);
    if (!a || prevAudios.get(a.id) !== a) continue; // 兩邊都改了（例如一起拖曳）就不用同步
    const sp = plainSpeed(c, modules);
    const want: Partial<AudioClip> = {};
    if (!near(a.start, c.start)) want.start = c.start;
    if (!near(a.duration, c.duration)) want.duration = c.duration;
    if (!near(a.in, c.in)) want.in = c.in;
    if (sp !== null && !near(a.rate ?? 1, sp)) want.rate = sp;
    if (Object.keys(want).length) aPatch.set(a.id, want);
  }
  for (const a of s.audios) {
    if (!a.link || prevAudios.get(a.id) === a) continue;
    const c = clipByLink.get(a.link);
    if (!c || prevClips.get(c.id) !== c) continue;
    const want: Partial<Clip> = {};
    if (!near(a.start, c.start)) want.start = a.start;
    if (!near(a.duration, c.duration)) want.duration = a.duration;
    if (!near(a.in, c.in)) want.in = a.in;
    if (Object.keys(want).length) cPatch.set(c.id, want);
  }
  if (!aPatch.size && !cPatch.size) return;
  syncing = true;
  useStore.setState({
    audios: aPatch.size ? s.audios.map((a) => (aPatch.has(a.id) ? { ...a, ...aPatch.get(a.id) } : a)) : s.audios,
    clips: cPatch.size ? s.clips.map((c) => (cPatch.has(c.id) ? { ...c, ...cPatch.get(c.id) } : c)) : s.clips,
  });
  syncing = false;
});

/** 這個影片片段的聲音是不是由連結的音訊片段負責（是的話影片本身不出聲） */
export function hasLinkedAudio(s: { audios: AudioClip[] }, c: Clip) {
  return !!c.link && s.audios.some((a) => a.link === c.link);
}
