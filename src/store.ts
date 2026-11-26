import { $t, displayName } from './i18n';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { BUILTIN_MODULES, NEW_MODULE_TEMPLATES, type Module, type ModuleKind } from './modules/builtin';
import { isHitFx, parseDuration, type ParamValues } from './engine/params';
import { clipSource, plainSpeed } from './engine/remap';
import { DEFAULT_TRANSFORM, EASES, normalizeScale, type EaseName, type Fit, type Transform } from './engine/transform';
import { DEFAULT_TRACKS, TRACK_H, displayRows, fxLevel, tracksFromOrder, visualRows, type TrackKind, type TrackState, type Tracks } from './engine/tracks';
import { remapDriveTracks } from './engine/audioReact';
export { DEFAULT_TRACKS, TRACK_H, displayRows, fxLevel, tracksFromOrder, visualRows, type TrackKind, type TrackState, type Tracks };
import { splitTiming, type FxTiming, type FxTrigger } from './engine/trigger';
import { ANIM_PROPS, newKey, scaleKeyList, scaleKeyMap, splitKeys, type Ease, type Keyframe, type Keys } from './engine/keyframes';
import { CURVE_ID, curveToKeys, parseCurve } from './engine/remapCurve';
import { fitStart, groupFits, resolveShift, overwriteParts, insertParts, type Span } from './engine/overlap';
import { fxCombo, stillDur, transDur, userTextStyle, type FxCombo } from './prefs';
import { PPS_MAX, PPS_MIN } from './engine/rulerTicks';
import { DEFAULT_TEXT, TEXT_PRESETS, type TextStyle } from './engine/text';
import type { Mask } from './engine/mask';
import type { FollowMap, Subject } from './engine/follow';

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
  /** 色板素材（純色）：色碼。不顯示在素材分頁、資料不見時會重新產生，不會遺失 */
  color?: string;
}

export interface TransitionRef {
  moduleId: string;
  params: ParamValues;
  duration: number;
  /** point 參數跟著片段追蹤的目標（沒有 = 照模組的 @follow 預設；null = 關掉） */
  follow?: FollowMap;
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
  /** 只聽這些軌道的聲音（軌道索引；video = 影片片段本身的聲音）；沒有 = 全部 */
  from?: AudioFrom;
}
export interface AudioFrom { audio?: number[]; video?: number[] }

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
  /** 片段本身的遮罩（每個片段最多一個，屬性面板的「遮罩」區塊；渲染時排在所有片段特效之後） */
  base?: boolean;
  /** 什麼時候作用（片段內時間）；沒有 = 整段 */
  timing?: FxTiming;
  /** point 參數跟著片段追蹤的目標（沒有 = 照模組的 @follow 預設；null = 關掉） */
  follow?: FollowMap;
}

export interface Clip extends ItemBase {
  id: string;
  mediaId: string;
  track: number;
  start: number;
  duration: number;
  in: number;
  /** keys：曲線模式（remap-curve）的素材時間曲線（片段內時間 → 素材時間，相對 in） */
  remap: { moduleId: string; params: ParamValues; keys?: Keyframe[] };
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
  /** AI 去背（U²-Netp，遮罩預先逐格算好） */
  aiMatte?: boolean;
  /** 追蹤的目標（臉部 / 自訂框選）；套在這個片段上（或看這個片段）的特效 / 轉場的中心會跟著它 */
  subject?: Subject;
  /** 舊版欄位，載入時會轉成 keys */
  transformEnd?: Transform | null;
  ease?: EaseName;
}

export type BlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'subtract' | 'lighten';
export type TimelineDropMode = 'overwrite' | 'insert' | 'insertAll' | 'trimFit' | 'speedFit';
export interface DropFit { duration: number; speed: boolean }
export interface PlacementGhost { type: ItemType; track: number; start: number; duration: number; label: string; thumb?: string }
export interface PasteResult { conflict: boolean; fit: DropFit | null; preview: PlacementGhost[] }

export interface FxItem extends ItemBase {
  id: string;
  moduleId: string;
  params: ParamValues;
  /** 參數跟著音量 / 節拍變化 */
  audio?: Record<string, AudioDrive>;
  /** point 參數跟著片段追蹤的目標（沒有 = 照模組的 @follow 預設；null = 關掉） */
  follow?: FollowMap;
  /** 跟隨目標時看哪一條影片軌的片段（沒有 = 自動：底下最上層有追蹤的片段） */
  subjectFrom?: number;
  /** 數值參數的關鍵影格（特效內時間）；遮罩的 key 叫 `mask.x` 之類 */
  keys?: Record<string, Keyframe[]>;
  /** 遮罩：只在這個區域套用特效 */
  mask?: Mask;
  /** 疊加的特效：主特效之後依序套用（各自有參數 / 遮罩 / 關鍵影格），一個方塊就是一組特效 */
  stack?: ClipFx[];
  /** 觸發：沒有 = 整個方塊播一次；有 = 每個節拍 / 剪接點從頭再播一次 */
  trigger?: FxTrigger;
  /** 轉場方塊（moduleId 是轉場模組）：每個剪接點的轉場長度（秒） */
  trDur?: number;
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
  /** false = 不提供時間軸的節拍格線（音效之類的） */
  beats?: boolean;
}

/** 輸出畫面大小（比例） */
export interface Format { w: number; h: number }
export interface Marker { id: string; t: number; name: string; color?: string }
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
  markers: Marker[];
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
  /** 匯出中：t = 正在輸出的那一格（播放列跟著跑），a ~ b = 匯出範圍 */
  exporting: { progress: number; cancel: boolean; t: number; a: number; b: number } | null;
  /** 輸出畫面大小 */
  format: Format;
  setFormat(f: Format): void;
  addMarker(t: number, name?: string): string;
  updateMarker(id: string, patch: Partial<Omit<Marker, 'id'>>): void;
  removeMarker(id: string): void;
  clearMarkers(): void;

  addMedia(m: Media): void;
  /** range：從素材預覽設定的入點 / 長度 */
  addClip(mediaId: string, start?: number, track?: number, range?: { in: number; duration: number }): void;
  addAudio(mediaId: string, start?: number, track?: number, range?: { in: number; duration: number }): void;
  updateClip(id: string, patch: Partial<Clip>): void;
  updateAudio(id: string, patch: Partial<AudioClip>): void;
  patchItems(patches: Record<string, Partial<AnyItem>>): void;
  resolveTimelineDrop(keys: string[], mode: TimelineDropMode, insertRange?: { start: number; length: number }): void;
  dropFit(keys: string[]): DropFit | null;
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
  /** 素材插到播放頭：選中的軌道有空位就放那裡，沒有就在它下方新增一條軌道 */
  insertMedia(mediaId: string, range?: { in: number; duration: number }): void;
  setRemap(clipId: string, moduleId: string): void;
  addEffect(moduleId: string, start: number, track?: number): void;
  addText(presetId: string, start?: number, track?: number, duration?: number): void;
  updateEffect(id: string, patch: Partial<FxItem>): void;
  /** 換成另一個特效模組（參數與參數的關鍵影格會清掉，遮罩保留） */
  replaceEffect(id: string, moduleId: string): void;
  relinkMedia(oldId: string, newId: string): void;
  /** 把單一片段換成另一個素材（位置、長度、變換、特效、轉場都保留）；回傳是否成功 */
  replaceClipMedia(clipId: string, mediaId: string): boolean;
  /** ripple = true：同一軌往前推；'all'：所有軌道一起往前推（其他軌被擋住時只推到不重疊為止） */
  removeSelection(ripple?: boolean | 'all'): void;
  /** 沒有選取時：移除選中軌道上播放頭所在的空白，後面的項目往前推 */
  removeGap(): boolean;
  split(): void;
  /** 把選取的項目在這些時間點全部切開（節拍分割）；回傳切了幾刀 */
  splitAtTimes(times: number[]): number;
  trim(side: 'start' | 'end'): void;
  nudge(dt: number): void;
  copy(): void;
  cut(): void;
  paste(at?: { time: number; track: number; kind: TrackKind }, mode?: TimelineDropMode): PasteResult | null;
  duplicate(mode?: TimelineDropMode): PasteResult | null;
  /** level：特效軌放在第幾條影片軌上方（沒給就自動） */
  addTrack(kind: TrackKind, at?: number, level?: number, row?: number): void;
  moveTrack(kind: TrackKind, from: number, to: number): void;
  /** 依顯示順序（由上到下、所有軌道）重新排列；影片 / 特效 / 音訊軌可以任意交錯 */
  reorderTracks(order: { kind: TrackKind; idx: number }[]): void;
  /** 刪除軌道（連同上面的項目）；影片軌至少要留一條 */
  deleteTrack(kind: TrackKind, idx: number): boolean;
  /** 軌道上有幾個項目（刪除前確認用） */
  trackItemCount(kind: TrackKind, idx: number): number;
  toggleTrack(kind: TrackKind, idx: number, key: 'hidden' | 'muted' | 'locked'): void;
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
  /** 移除影片片段的原音與連結音訊；回傳是否成功 */
  removeClipAudio(clipId: string): boolean;
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

/** 文字分頁的樣式（預設 / 我的樣式）→ 文字片段；我的樣式會一起套上存下來的轉場與片段特效（模組已刪除的略過） */
export function makeTextClip(presetId: string, modules: Module[], p: Partial<Clip>): Clip {
  const user = userTextStyle(presetId);
  const pre = TEXT_PRESETS.find((x) => x.id === presetId) ?? TEXT_PRESETS[0];
  const clip = makeClip({
    mediaId: '',
    fit: 'contain',
    text: user ? { ...DEFAULT_TEXT, ...user.style } : { ...DEFAULT_TEXT, ...pre.style },
    transform: user ? { ...DEFAULT_TRANSFORM, ...user.transform } : { ...DEFAULT_TRANSFORM, y: pre.y },
    ...p,
  });
  if (user) {
    const has = (id?: string) => !!id && modules.some((m) => m.id === id);
    clip.transitionIn = has(user.transitionIn?.moduleId) ? structuredClone(user.transitionIn) : null;
    clip.transitionOut = has(user.transitionOut?.moduleId) ? structuredClone(user.transitionOut) : null;
    const fx = user.effects.filter((f) => has(f.moduleId)).map((f) => ({ ...structuredClone(f), id: uid() }));
    if (fx.length) clip.effects = fx;
  }
  return clip;
}

/** 轉場方塊放上時間軸的預設長度（秒） */
export const TR_BLOCK_DUR = 4;

/** 片段特效的預設作用範圍：衝擊特效（// @hit）= 片段開頭打一下（長度 = @duration）；持續特效 = 整段 */
export function defaultTiming(m: { kind: string; code: string } | undefined): FxTiming | undefined {
  return m && isHitFx(m) ? { kind: 'hits', hits: [{ t: 0, d: parseDuration(m.code, 0.5) }] } : undefined;
}

/** 組合 → 特效方塊的內容（疊加的特效換新 id；方塊名稱 = 組合名稱） */
function comboItem(combo: FxCombo) {
  const c = structuredClone(combo.fx);
  return { ...c, name: displayName(combo.name), stack: c.stack?.map((x) => ({ ...x, id: uid() })) };
}
/** 加片段特效：一般模組 = 一個；我的組合 = 主特效 + 疊加的特效 */
export function comboClipFx(moduleId: string): ClipFx[] {
  const combo = fxCombo(moduleId);
  if (!combo) return [{ id: uid(), moduleId, params: {} }];
  const c = comboItem(combo);
  const keys = Object.fromEntries(Object.entries(c.keys ?? {}).filter(([k]) => !k.startsWith('mask.')));
  return [{ id: uid(), moduleId: c.moduleId, params: c.params, keys, audio: c.audio }, ...(c.stack ?? [])];
}

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
  // 文字樣式缺欄位時用預設值補（例如新加的 fill / strokes），不然渲染會出錯
  if (c.text) c.text = { ...DEFAULT_TEXT, ...c.text };
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
    if (c.remap.moduleId === CURVE_ID && c.remap.keys) {
      patch.remap = { ...c.remap, keys: scaleKeyList(c.remap.keys, s) }; // 曲線跟著拉長 = 整條變慢
    } else if (c.remap.moduleId === 'remap-speed') {
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
  // 有觸發的方塊：關鍵影格是「每次觸發」的時間，不跟著方塊長度縮放
  if (f.trigger) return base as Partial<FxItem>;
  return {
    ...base,
    keys: scaleKeyMap(f.keys, s),
    ...(f.stack ? { stack: f.stack.map((x) => (x.keys ? { ...x, keys: scaleKeyMap(x.keys, s) as Record<string, Keyframe[]> } : x)) } : {}),
  } as Partial<FxItem>;
}

/**
 * 換變速模式：
 * - 素材庫裡存的曲線（程式碼有 // @curve）→ 曲線模式，曲線依片段長度展開成關鍵影格
 * - 切到「曲線」→ 從目前的速度（含倒放）開始；本來就是曲線就保留
 * avail：素材從 in 之後還有幾秒；曲線會用掉更多素材（例如快轉）時整條等比例壓低，不會跑到素材結尾後定格
 */
export function remapFor(c: Clip, moduleId: string, modules: Module[], avail?: number): Clip['remap'] {
  const curve = parseCurve(modules.find((m) => m.id === moduleId)?.code ?? '');
  if (curve) {
    let keys = curveToKeys(curve, c.duration);
    const top = Math.max(...keys.map((k) => k.v));
    if (avail !== undefined && avail > 0 && top > avail) keys = keys.map((k) => ({ ...k, v: (k.v * avail) / top }));
    return { moduleId: CURVE_ID, params: {}, keys };
  }
  if (moduleId !== CURVE_ID) return { moduleId, params: {} };
  if (c.remap.moduleId === CURVE_ID && c.remap.keys?.length) return c.remap;
  const lin: Ease = [0, 0, 1, 1];
  const sp = itemSpeed('clip', c) ?? 1;
  const end = c.duration * sp;
  const rev = c.remap.moduleId === 'remap-speed' && !!c.remap.params.reverse;
  return { moduleId, params: {}, keys: rev ? [newKey(0, end, lin), newKey(c.duration, 0, lin)] : [newKey(0, 0, lin), newKey(c.duration, end, lin)] };
}

/** 影片片段從 in 之後還有幾秒素材（不是影片就 undefined） */
export function srcAvail(c: Clip, media: Media[]): number | undefined {
  const m = media.find((x) => x.id === c.mediaId);
  return m && m.kind === 'video' ? Math.max(0, m.duration - c.in) : undefined;
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
export const trackLocked = (s: { tracks: Tracks }, type: ItemType, track: number) => !!s.tracks[KIND_OF[type]][track]?.locked;

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
        if (s.selected.length) return s.selected.map(parseKey).filter(({ type, id }) => { const it = findItem(type, id); return it && !trackLocked(s, type, it.track); });
        if (s.selection && isItem(s.selection.type)) { const it = findItem(s.selection.type, s.selection.id); return it && !trackLocked(s, s.selection.type, it.track) ? [{ type: s.selection.type, id: s.selection.id }] : []; }
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
          // 曲線模式：曲線也切兩段；後段的 in 變了，素材時間要扣回來
          let remapA = c.remap, remapB = c.remap;
          if (c.remap.moduleId === CURVE_ID && c.remap.keys?.length) {
            const [a, b] = splitKeys({ x: c.remap.keys }, local);
            remapA = { ...c.remap, keys: a.x };
            remapB = { ...c.remap, keys: b.x?.map((k) => ({ ...k, v: k.v - (inB - c.in) })) };
          }
          const fxA: ClipFx[] = [], fxB: ClipFx[] = [];
          for (const f of c.effects ?? []) {
            const a: Record<string, Keyframe[]> = {}, b: Record<string, Keyframe[]> = {};
            for (const [p, list] of Object.entries(f.keys ?? {})) {
              const [x, y] = splitKeys({ x: list }, local);
              if (x.x) a[p] = x.x;
              if (y.x) b[p] = y.x;
            }
            const [ta, tb] = splitTiming(f.timing, local);
            fxA.push({ ...f, keys: a, timing: ta });
            fxB.push({ ...f, id: uid(), keys: b, timing: tb });
          }
          if (c.effects) {
            return [
              { ...c, duration: local, keys: ka, transitionOut: null, effects: fxA, remap: remapA },
              { ...c, id: uid(), start: t, duration: c.duration - local, in: inB, transitionIn: null, keys: kb, effects: fxB, remap: remapB },
            ];
          }
          return [
            { ...c, duration: local, keys: ka, transitionOut: null, remap: remapA },
            { ...c, id: uid(), start: t, duration: c.duration - local, in: inB, transitionIn: null, keys: kb, remap: remapB },
          ];
        }
        if (type === 'audio') {
          const a = it as AudioClip;
          return [{ ...a, duration: local, fadeOut: 0 }, { ...a, id: uid(), start: t, duration: a.duration - local, in: a.in + local * (a.rate ?? 1), fadeIn: 0 }];
        }
        const f = it as FxItem;
        // 有觸發的方塊：關鍵影格是「每次觸發」的時間，兩半都照原樣保留；手動的 Hit 分到兩段
        if (f.trigger) {
          const tr = f.trigger;
          const [ta, tb] = tr.kind === 'hits' ? splitTiming({ kind: 'hits', hits: tr.hits }, local) : [];
          const half = (x: FxTiming | undefined) => (x?.kind === 'hits' ? { ...tr, hits: x.hits } : tr);
          return [{ ...f, duration: local, trigger: half(ta) }, { ...f, id: uid(), start: t, duration: f.duration - local, trigger: half(tb), stack: f.stack?.map((x) => ({ ...x, id: uid() })) }];
        }
        const splitMap = (keys: Record<string, Keyframe[]> | undefined) => {
          const ka: Record<string, Keyframe[]> = {}, kb: Record<string, Keyframe[]> = {};
          for (const [p, list] of Object.entries(keys ?? {})) {
            const [a, b] = splitKeys({ x: list }, local);
            if (a.x) ka[p] = a.x;
            if (b.x) kb[p] = b.x;
          }
          return [ka, kb] as const;
        };
        const [ka, kb] = splitMap(f.keys);
        const stacks = f.stack?.map((x) => ({ x, k: splitMap(x.keys) }));
        return [
          { ...f, duration: local, keys: ka, ...(stacks ? { stack: stacks.map(({ x, k }) => ({ ...x, keys: k[0] })) } : {}) },
          { ...f, id: uid(), start: t, duration: f.duration - local, keys: kb, ...(stacks ? { stack: stacks.map(({ x, k }) => ({ ...x, id: uid(), keys: k[1] })) } : {}) },
        ];
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
            ...s.clips.filter((c) => inside(c, t) && !trackLocked(s, 'clip', c.track)).map((c) => ({ type: 'clip' as const, id: c.id })),
            ...s.audios.filter((c) => inside(c, t) && !trackLocked(s, 'audio', c.track)).map((c) => ({ type: 'audio' as const, id: c.id })),
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

      /** 單一可見片段（含連結原音）到下一個片段之間，是否有可縮入的空隙。 */
      const dropFit = (items: { type: ItemType; item: AnyItem }[], s: State, exclude = new Set<string>()): DropFit | null => {
        const clips = items.filter((x) => x.type === 'clip').map((x) => x.item as Clip);
        const visible = items.filter((x) => x.type !== 'audio' || !x.item.link || !clips.some((c) => c.link === x.item.link));
        if (visible.length !== 1) return null;
        const { type, item } = visible[0];
        const targetLane = laneOf(type, item.track);
        const attached = attachedAudioIds(s);
        const clipByLink = new Map(s.clips.filter((c) => c.link).map((c) => [c.link, c]));
        let gap = Infinity;
        for (const otherType of ['clip', 'effect', 'audio'] as ItemType[]) {
          for (const other of s[LIST[otherType]] as AnyItem[]) {
            if (exclude.has(keyOf(otherType, other.id))) continue;
            const parent = otherType === 'audio' && attached.has(other.id) ? clipByLink.get(other.link) : undefined;
            const otherLane = parent ? laneOf('clip', parent.track) : laneOf(otherType, other.track);
            if (otherLane !== targetLane || other.start + other.duration <= item.start + 1e-4) continue;
            gap = Math.min(gap, Math.max(0, other.start - item.start));
          }
        }
        if (!Number.isFinite(gap) || gap < 0.05 || gap >= item.duration - 1e-4) return null;
        const media = type === 'clip' ? s.media.find((m) => m.id === (item as Clip).mediaId) : undefined;
        const speed = type === 'clip' && media?.kind === 'video' && (item as Clip).remap.moduleId === 'remap-speed'
          && Number((item as Clip).remap.params.speed ?? 1) * item.duration / gap <= 8 + 1e-4;
        return { duration: gap, speed };
      };

      const pasteItems = (items: { type: ItemType; item: AnyItem }[], base: number, at?: { track: number; kind: TrackKind }, mode?: TimelineDropMode): PasteResult | null => {
        if (!items.length) return null;
        const s = get();
        const minStart = Math.min(...items.map((i) => i.item.start));
        const add: Record<string, AnyItem[]> = { clips: [], effects: [], audios: [] };
        const keys: string[] = [];
        const targetKind = at?.kind;
        const sourceTracks = items.filter((x) => KIND_OF[x.type] === targetKind).map((x) => x.item.track);
        const firstTrack = sourceTracks.length ? Math.min(...sourceTracks) : 0;
        for (const { type, item } of items) {
          const kind = KIND_OF[type];
          let track = item.track;
          if (at && at.kind === kind) track += at.track - firstTrack;
          track = Math.max(0, Math.min(track, s.tracks[kind].length - 1));
          if (s.tracks[kind][track]?.locked) return null;
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
        const prepared = (['clip', 'effect', 'audio'] as ItemType[]).flatMap((type) => add[LIST[type]].map((item) => ({ type, item })));
        const linked = new Set((add.clips as Clip[]).map((c) => c.link).filter(Boolean));
        const visible = prepared.filter(({ type, item }) => type !== 'audio' || !item.link || !linked.has(item.link));
        const preview: PlacementGhost[] = visible.map(({ type, item }) => {
          const media = type !== 'effect' ? s.media.find((m) => m.id === (item as Clip | AudioClip).mediaId) : undefined;
          const module = type === 'effect' ? s.modules.find((m) => m.id === (item as FxItem).moduleId) : undefined;
          return { type, track: item.track, start: item.start, duration: item.duration, label: item.name ?? media?.name ?? module?.name ?? '', thumb: type === 'clip' ? media?.thumb : undefined };
        });
        const moving = visible
          .map(({ type, item }) => ({ lane: laneOf(type, item.track), start: item.start, duration: item.duration }));
        const others = spansOf(s);
        const conflict = moving.some((m) => others.some((o) => m.lane === o.lane && m.start < o.start + o.duration - 1e-4 && o.start < m.start + m.duration - 1e-4));
        const fit = dropFit(prepared, s);
        if (!mode && conflict) return { conflict, fit, preview };
        if ((mode === 'trimFit' || mode === 'speedFit') && (!fit || (mode === 'speedFit' && !fit.speed))) return { conflict, fit, preview };
        if (mode === 'trimFit' || mode === 'speedFit') {
          for (const { type, item } of prepared) {
            if (mode === 'speedFit') Object.assign(item, stretchPatch(type, item, item.start, fit!.duration / item.duration));
            else {
              item.duration = fit!.duration;
              if (type === 'audio') (item as AudioClip).fadeOut = 0;
            }
          }
        }
        const last = parseKey(keys[keys.length - 1]);
        set({
          clips: [...s.clips, ...(add.clips as Clip[])],
          effects: [...s.effects, ...(add.effects as FxItem[])],
          audios: [...s.audios, ...(add.audios as AudioClip[])],
          selected: keys,
          selection: last,
        });
        if (mode === 'overwrite' || mode === 'insert' || mode === 'insertAll') get().resolveTimelineDrop(keys, mode);
        return { conflict: false, fit: null, preview: [] };
      };

      return {
        media: [],
        clips: [],
        effects: [],
        audios: [],
        markers: [],
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
        addMarker: (t, name) => {
          const id = uid();
          set((s) => ({ markers: [...s.markers, { id, t: Math.max(0, t), name: name ?? $t('標記 {0}', s.markers.length + 1) }].sort((a, b) => a.t - b.t) }));
          return id;
        },
        updateMarker: (id, patch) => set((s) => ({ markers: s.markers.map((m) => m.id === id ? { ...m, ...patch, t: Math.max(0, patch.t ?? m.t) } : m).sort((a, b) => a.t - b.t) })),
        removeMarker: (id) => set((s) => ({ markers: s.markers.filter((m) => m.id !== id) })),
        clearMarkers: () => set((s) => s.markers.length ? { markers: [] } : {}),

        addMedia: (m) => set((s) => ({ media: [...s.media, m] })),

        addClip: (mediaId, start, trackArg, range) => {
          const s = get();
          let track = trackArg ?? (s.activeTrack?.kind === 'video' ? s.activeTrack.idx : 0);
          const media = s.media.find((m) => m.id === mediaId);
          if (!mediaUsable(media)) return;
          if (media.kind === 'audio') return s.addAudio(mediaId, start, undefined, range);
          track = Math.min(track, s.tracks.video.length - 1);
          if (s.tracks.video[track]?.locked) return;
          const duration = range ? range.duration : media.kind === 'video' ? media.duration : stillDur(); // 影片放完整長度、圖片用設定的預設長度
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
            let at = s.tracks.audio.findIndex((t, i) => !t.locked && Math.abs(fitStart(spans, laneOf('audio', i), clip.start, clip.duration) - clip.start) < 1e-6);
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
          if (s.tracks.audio[track]?.locked) return;
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

        updateClip: (id, patch) => set((s) => ({ clips: s.clips.map((c) => (c.id === id && !trackLocked(s, 'clip', c.track) && !trackLocked(s, 'clip', patch.track ?? c.track) ? { ...c, ...patch } : c)) })),
        updateAudio: (id, patch) => set((s) => ({ audios: s.audios.map((c) => (c.id === id && !trackLocked(s, 'audio', c.track) && !trackLocked(s, 'audio', patch.track ?? c.track) ? { ...c, ...patch } : c)) })),

        patchItems: (patches) =>
          set((s) => {
            const apply = <T extends AnyItem>(type: ItemType, list: T[]) =>
              list.map((x) => {
                const p = patches[keyOf(type, x.id)];
                return p && !trackLocked(s, type, x.track) && !trackLocked(s, type, p.track ?? x.track) ? ({ ...x, ...p } as T) : x;
              });
            return { clips: apply('clip', s.clips), effects: apply('effect', s.effects), audios: apply('audio', s.audios) };
          }),

        resolveTimelineDrop: (keys, mode, insertRange) => {
          const s = get();
          const moving = new Set(keys);
          if ((['clip', 'effect', 'audio'] as ItemType[]).some((type) => (s[LIST[type]] as AnyItem[]).some((it) => moving.has(keyOf(type, it.id)) && trackLocked(s, type, it.track)))) return;
          if (mode === 'trimFit' || mode === 'speedFit') {
            const items = (['clip', 'effect', 'audio'] as ItemType[]).flatMap((type) =>
              (s[LIST[type]] as AnyItem[]).filter((item) => moving.has(keyOf(type, item.id))).map((item) => ({ type, item })));
            const fit = dropFit(items, s, moving);
            if (!fit || (mode === 'speedFit' && !fit.speed)) return;
            const patches: Record<string, Partial<AnyItem>> = {};
            for (const { type, item } of items) {
              patches[keyOf(type, item.id)] = mode === 'speedFit'
                ? stretchPatch(type, item, item.start, fit.duration / item.duration)
                : { duration: fit.duration, ...(type === 'audio' ? { fadeOut: 0 } : {}) };
            }
            get().patchItems(patches);
            return;
          }
          const attached = attachedAudioIds(s);
          const clipByLink = new Map(s.clips.filter((c) => c.link).map((c) => [c.link, c]));
          const lane = (type: ItemType, it: AnyItem) => {
            const parent = type === 'audio' && attached.has(it.id) ? clipByLink.get(it.link) : undefined;
            return parent ? laneOf('clip', parent.track) : laneOf(type, it.track);
          };
          const dragged = (['clip', 'effect', 'audio'] as ItemType[]).flatMap((type) =>
            (s[LIST[type]] as AnyItem[]).filter((it) => moving.has(keyOf(type, it.id)))
              .map((it) => ({ lane: lane(type, it), start: it.start, duration: it.duration })));
          if (!dragged.length) return;
          const insertAt = insertRange?.start ?? Math.min(...dragged.map((x) => x.start));
          const insertLength = insertRange?.length ?? Math.max(...dragged.map((x) => x.start + x.duration)) - insertAt;
          const lanes = new Set(dragged.map((x) => x.lane));
          const lists: Record<string, AnyItem[]> = { clips: [], effects: [], audios: [] };
          const newBacks: AnyItem[] = [];
          for (const type of ['clip', 'effect', 'audio'] as ItemType[]) {
            for (const it of s[LIST[type]] as AnyItem[]) {
              if (trackLocked(s, type, it.track)) { lists[LIST[type]].push(it); continue; }
              if (moving.has(keyOf(type, it.id)) || (mode !== 'insertAll' && !lanes.has(lane(type, it)))) {
                lists[LIST[type]].push(it);
                continue;
              }
              const spans = mode === 'overwrite'
                ? overwriteParts(it.start, it.duration, dragged.filter((x) => x.lane === lane(type, it)))
                : insertParts(it.start, it.duration, insertAt, insertLength);
              if (!spans.length) continue;
              let pieces: AnyItem[] = [it];
              const boundaries = [...new Set(mode !== 'overwrite' ? [insertAt] : spans.flatMap((p) => [p.start, p.start + p.duration]))]
                .filter((t) => t > it.start + 1e-4 && t < it.start + it.duration - 1e-4).sort((a, b) => a - b);
              for (const t of boundaries) {
                pieces = pieces.flatMap((p) => t > p.start + 1e-4 && t < p.start + p.duration - 1e-4 ? splitOne(type, p, t) : [p]);
              }
              const used = new Set<string>();
              for (const target of spans) {
                const piece = pieces.find((p) => Math.abs(p.start - (mode !== 'overwrite' && target.start >= insertAt + insertLength - 1e-4 ? target.start - insertLength : target.start)) < 1e-4 && Math.abs(p.duration - target.duration) < 1e-4 && !used.has(p.id));
                if (!piece) continue;
                used.add(piece.id);
                const result = target.start === piece.start ? piece : { ...piece, start: target.start };
                lists[LIST[type]].push(result);
                if (piece.id !== it.id) newBacks.push(result);
              }
            }
          }
          // New right-hand pieces remain linked to their matching audio, but not to the left-hand pieces.
          const byStart = new Map<string, AnyItem[]>();
          for (const it of newBacks) {
            const k = it.start.toFixed(4);
            byStart.set(k, [...(byStart.get(k) ?? []), it]);
          }
          const fresh = new Map([...byStart.values()].flatMap((g) => freshIds(g)).map((x) => [x.id, x]));
          for (const k of Object.keys(lists)) lists[k] = lists[k].map((x) => fresh.get(x.id) ?? x);
          set({ clips: lists.clips as Clip[], effects: lists.effects as FxItem[], audios: lists.audios as AudioClip[] });
        },

        dropFit: (keys) => {
          const s = get();
          const moving = new Set(keys);
          const items = (['clip', 'effect', 'audio'] as ItemType[]).flatMap((type) =>
            (s[LIST[type]] as AnyItem[]).filter((item) => moving.has(keyOf(type, item.id))).map((item) => ({ type, item })));
          return dropFit(items, s, moving);
        },

        setTransition: (clipId, moduleId, side = 'in') =>
          set((s) => {
            const f = side === 'out' ? 'transitionOut' : 'transitionIn';
            return {
              clips: s.clips.map((c) => {
                if (c.id !== clipId) return c;
                const cur = c[f];
                return { ...c, [f]: moduleId ? { moduleId, params: cur?.moduleId === moduleId ? cur.params : {}, duration: cur?.duration ?? transDur() } : null };
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
          const ref = (): TransitionRef => ({ moduleId: tpl.moduleId, params: { ...(tpl.params ?? {}) }, duration: tpl.duration ?? transDur() });
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
          // 選中的軌道 → 選取的項目所在的軌道 → 預設（影片 = 最上層、其他 = 第一條）
          const sel = s.selection;
          const selIt = sel && isItem(sel.type) && KIND_OF[sel.type] === kind ? findItem(sel.type, sel.id) : undefined;
          const at = s.activeTrack?.kind === kind ? Math.min(s.activeTrack.idx, n - 1) : selIt ? selIt.track : kind === 'video' ? n - 1 : 0;
          const spans = spansOf(s);
          if (!s.tracks[kind][at]?.locked && Math.abs(fitStart(spans, `${kind}:${at}`, start, duration) - start) < 1e-6) return at;
          // 被佔用：在它「畫面上的下方」新增一條
          let idx: number;
          if (kind === 'audio') {
            // 音訊軌依 row、再依編號排：插在它後面、同一個 row = 緊接在下面
            idx = at + 1;
            s.addTrack('audio', idx, undefined, s.tracks.audio[at]?.row);
          } else {
            // 影片 / 特效：編號越大越上層；上層顯示在上面（upperAt = top）時，下方 = 同一個編號（原本的往上推）
            idx = s.upperAt === 'top' ? at : at + 1;
            s.addTrack(kind, idx, kind === 'fx' ? fxLevel(s.tracks, at) : undefined);
          }
          set({ activeTrack: { kind, idx } });
          return idx;
        },

        insertMedia: (mediaId, range) => {
          const s = get();
          const media = s.media.find((m) => m.id === mediaId);
          if (!mediaUsable(media)) return;
          if (media.kind === 'audio' && !media.hasAudio) return;
          const kind: TrackKind = media.kind === 'audio' ? 'audio' : 'video';
          const dur = range?.duration ?? (media.kind === 'image' ? stillDur() : media.duration);
          const t = s.time;
          const track = s.trackForInsert(kind, t, dur);
          get().addClip(mediaId, t, track, range);
        },

        setRemap: (clipId, moduleId) =>
          set((s) => ({
            clips: s.clips.map((c) => (c.id === clipId ? { ...c, remap: remapFor(c, moduleId, s.modules, srcAvail(c, s.media)) } : c)),
            selection: { type: 'clip', id: clipId },
            selected: [keyOf('clip', clipId)],
            leftTab: 'editor',
          })),

        addEffect: (moduleId, start, trackArg) => {
          if (!get().tracks.fx.length) get().addTrack('fx');
          const s = get();
          let track = trackArg ?? (s.activeTrack?.kind === 'fx' ? s.activeTrack.idx : 0);
          // 我的組合（combo:）：主特效 + 疊加 + 觸發整組放上去
          const combo = fxCombo(moduleId);
          const m = s.modules.find((x) => x.id === (combo ? combo.fx.moduleId : moduleId));
          if (!m) return;
          track = Math.max(0, Math.min(track, s.tracks.fx.length - 1));
          if (s.tracks.fx[track]?.locked) return;
          // 轉場模組放到特效軌 = 轉場方塊：範圍內每個剪接點自動套用
          const isTr = m.kind === 'transition';
          const duration = combo ? combo.fx.duration : isTr ? TR_BLOCK_DUR : parseDuration(m.code, 0.5);
          const at = fitStart(spansOf(s), laneOf('effect', track), Math.max(0, start), duration);
          const fx: FxItem = combo
            ? { ...comboItem(combo), id: uid(), start: at, track }
            : isTr
              ? { id: uid(), moduleId, params: {}, start: at, duration, track, trigger: { kind: 'cut' }, trDur: transDur() }
              : { id: uid(), moduleId, params: {}, start: at, duration, track };
          set({ effects: [...s.effects, fx], selection: { type: 'effect', id: fx.id }, selected: [keyOf('effect', fx.id)], leftTab: 'editor' });
        },

        addText: (presetId, start, track, duration) => {
          const s = get();
          const dur = duration ?? stillDur();
          // 預設放在最上面的影片軌
          const tk = Math.max(0, Math.min(track ?? s.tracks.video.length - 1, s.tracks.video.length - 1));
          if (s.tracks.video[tk]?.locked) return;
          const t0 = Math.max(0, start ?? s.time);
          const clip = makeTextClip(presetId, s.modules, { track: tk, start: fitStart(spansOf(s), laneOf('clip', tk), t0, dur), duration: dur });
          set({ clips: [...s.clips, clip], selection: { type: 'clip', id: clip.id }, selected: [keyOf('clip', clip.id)], leftTab: 'editor' });
        },

        updateEffect: (id, patch) => set((s) => ({ effects: s.effects.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),

        replaceEffect: (id, moduleId) =>
          set((s) => ({
            effects: s.effects.map((e) => {
              if (e.id !== id) return e;
              const keys: Record<string, Keyframe[]> = {};
              for (const [k, v] of Object.entries(e.keys ?? {})) if (k.startsWith('mask.')) keys[k] = v;
              // 我的組合：換成整組（遮罩、位置、長度保留）
              const combo = fxCombo(moduleId);
              if (combo) {
                const c = comboItem(combo);
                return { ...e, name: c.name, moduleId: c.moduleId, params: c.params, keys: { ...(c.keys ?? {}), ...keys }, audio: c.audio, stack: c.stack, trigger: c.trigger };
              }
              return { ...e, name: undefined, moduleId, params: {}, keys };
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

        replaceClipMedia: (clipId, mediaId) => {
          const s = get();
          const c = s.clips.find((x) => x.id === clipId);
          const m = s.media.find((x) => x.id === mediaId);
          if (!c || c.text || !mediaUsable(m) || m.kind === 'audio') return false;
          // 影片比原本的片段短：長度縮到新影片的長度（照目前速度）
          let duration = c.duration;
          if (m.kind === 'video') duration = Math.min(duration, m.duration / (itemSpeed('clip', c) || 1));
          const old = c.link ? s.audios.find((a) => a.link === c.link) : undefined;
          const nc: Clip = { ...c, mediaId, in: 0, duration, aiMatte: undefined, link: undefined };
          let audios = old ? s.audios.filter((a) => a.id !== old.id) : s.audios;
          let tracks = s.tracks;
          const selected = [keyOf('clip', clipId)];
          // 新的是有聲音的影片：一樣放一段連結的音訊（原本那條音訊軌有空就放回去）
          if (m.kind === 'video' && m.hasAudio) {
            const spans = spansOf({ ...s, audios });
            const free = (i: number) => Math.abs(fitStart(spans, laneOf('audio', i), nc.start, nc.duration) - nc.start) < 1e-6;
            let at = old && free(old.track) ? old.track : s.tracks.audio.findIndex((_, i) => free(i));
            if (at < 0) {
              tracks = { ...s.tracks, audio: [...s.tracks.audio, {}] };
              at = tracks.audio.length - 1;
            }
            nc.link = uid();
            const a = makeAudio({ mediaId, track: at, start: nc.start, duration: nc.duration, in: 0, link: nc.link, volume: old?.volume ?? 1 });
            audios = [...audios, a];
            selected.push(keyOf('audio', a.id));
          }
          set({ clips: s.clips.map((x) => (x.id === clipId ? nc : x)), audios, tracks, selection: { type: 'clip', id: clipId }, selected, leftTab: 'editor' });
          return true;
        },

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
            .filter((d): d is { type: ItemType; it: AnyItem } => !!d.it && !trackLocked(s, d.type, d.it.track))
            .sort((a, b) => b.it.start - a.it.start); // 從後面刪，波紋位移才不會互相干擾
          if (!dels.length) return void (s.selected.length || s.selection ? undefined : get().removeGap());
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
                  if (trackLocked(s, t, x.track)) continue;
                  const lane = `${KIND_OF[t]}:${x.track}`;
                  if (!lanes.has(lane)) lanes.set(lane, b - a);
                  // 留在原地、但結尾超過 a 的項目會擋住後面的東西
                  if (x.start < b - 1e-3 && x.start + x.duration > a) lanes.set(lane, Math.min(lanes.get(lane)!, Math.max(0, b - (x.start + x.duration))));
                }
              }
              for (const t of ['clip', 'effect', 'audio'] as ItemType[]) {
                lists[LIST[t]] = lists[LIST[t]].map((x) => {
                  if (t === 'audio' && attached.has(x.id)) return x; // 連結音訊跟著影片同步
                  if (trackLocked(s, t, x.track)) return x;
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
              if (ripple) l = l.map((x) => (x.track === it.track && !trackLocked(s, type, x.track) && x.start >= end - 1e-3 ? { ...x, start: Math.max(0, x.start - it.duration) } : x));
              lists[key] = l;
            }
          }
          set({ clips: lists.clips as Clip[], effects: lists.effects as FxItem[], audios: lists.audios as AudioClip[], selection: null, selected: [] });
        },

        removeGap: () => {
          const s = get();
          const at = s.activeTrack;
          if (!at) return false;
          if (s.tracks[at.kind][at.idx]?.locked) return false;
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

        splitAtTimes: (times) => {
          const s = get();
          const list = targets();
          if (!list.length) return 0;
          const ts = [...times].sort((a, b) => a - b);
          const lists: Record<string, AnyItem[]> = { clips: s.clips, effects: s.effects, audios: s.audios };
          const newKeys: string[] = [];
          const backs: AnyItem[] = [];
          let cuts = 0;
          for (const { type, id } of list) {
            const key = LIST[type];
            let cur = lists[key].find((x) => x.id === id);
            if (!cur) continue;
            newKeys.push(keyOf(type, cur.id));
            const pieces: AnyItem[] = [];
            for (const t of ts) {
              if (!inside(cur, t)) continue;
              const [a, b] = splitOne(type, cur, t);
              pieces.push(a);
              newKeys.push(keyOf(type, b.id));
              cur = b;
              cuts++;
            }
            if (!pieces.length) continue;
            pieces.push(cur);
            // 新的連結 / 群組 id 要用「切完的最後版本」：中間的段落後來又被切過，id 相同但長度不一樣
            backs.push(...pieces.slice(1));
            lists[key] = lists[key].flatMap((x) => (x.id === id ? pieces : [x]));
          }
          if (!cuts) return 0;
          // 切出來的每一段各自一組連結 / 群組（同一個時間點切開的影片跟原音還是連在一起）
          const byStart = new Map<string, AnyItem[]>();
          for (const b of backs) {
            const k = b.start.toFixed(4);
            byStart.set(k, [...(byStart.get(k) ?? []), b]);
          }
          const fresh = new Map([...byStart.values()].flatMap((g) => freshIds(g)).map((x) => [x.id, x]));
          for (const k of Object.keys(lists)) lists[k] = lists[k].map((x) => fresh.get(x.id) ?? x);
          set({ clips: lists.clips as Clip[], effects: lists.effects as FxItem[], audios: lists.audios as AudioClip[], selected: newKeys, selection: parseKey(newKeys[0]) });
          return cuts;
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

        paste: (at, mode) => {
          const s = get();
          const target = at ?? (s.activeTrack ? { kind: s.activeTrack.kind, track: s.activeTrack.idx } : undefined);
          return s.clipboard ? pasteItems(s.clipboard.items, at?.time ?? s.time, target, mode) : null;
        },

        duplicate: (mode) => {
          const items = targets()
            .map(({ type, id }) => ({ type, item: findItem(type, id) }))
            .filter((x): x is { type: ItemType; item: AnyItem } => !!x.item);
          if (!items.length) return null;
          const end = Math.max(...items.map((i) => i.item.start + i.item.duration));
          return pasteItems(items, end, undefined, mode);
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
            const items = kind === 'video' ? { clips: shift(s.clips) } : kind === 'fx' ? { effects: shift(s.effects) } : { audios: shift(s.audios) };
            return {
              activeTrack: act,
              tracks: next,
              ...items,
              // 音訊反應的來源軌道跟著往後挪
              ...(kind === 'fx' ? {} : remapDriveTracks({ clips: items.clips ?? s.clips, effects: s.effects }, kind, (j) => (j >= i ? j + 1 : j))),
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
            const items = kind === 'video' ? { clips: remap(s.clips) } : kind === 'fx' ? { effects: remap(s.effects) } : { audios: remap(s.audios) };
            return {
              activeTrack: s.activeTrack?.kind === kind ? { kind, idx: newIdx.get(s.activeTrack.idx) ?? s.activeTrack.idx } : s.activeTrack,
              tracks: { ...s.tracks, [kind]: order.map((o) => s.tracks[kind][o]) },
              ...items,
              ...(kind === 'fx' ? {} : remapDriveTracks({ clips: items.clips ?? s.clips, effects: s.effects }, kind, (j) => newIdx.get(j) ?? j)),
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
            let fixed = { clips: remap(s.clips, 'video'), effects: remap(s.effects, 'fx') };
            for (const k of ['video', 'audio'] as const) fixed = remapDriveTracks(fixed, k, (j) => maps[k].get(j) ?? j);
            return {
              tracks,
              ...fixed,
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
          if (s.tracks[kind][idx]?.locked) return false;
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
          // 音訊反應的來源：刪掉的軌道拿掉、後面的往前補
          if (kind !== 'fx') ({ clips, effects } = remapDriveTracks({ clips, effects }, kind, (j) => (j === idx ? null : j > idx ? j - 1 : j)));
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
          set((s) => {
            const tracks = { ...s.tracks, [kind]: s.tracks[kind].map((t, i) => (i === idx ? { ...t, [key]: !t[key] } : t)) };
            if (key !== 'locked' || !tracks[kind][idx]?.locked) return { tracks };
            const list = kind === 'video' ? s.clips : kind === 'fx' ? s.effects : s.audios;
            const ids = new Set(list.filter((x) => x.track === idx).map((x) => x.id));
            const selected = s.selected.filter((k) => !ids.has(parseKey(k).id));
            const selection = s.selection && isItem(s.selection.type) && ids.has(s.selection.id) ? null : s.selection;
            return { tracks, selected, selection };
          }),
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
          const item = findItem(sel.type, sel.id);
          if (item && trackLocked(s, sel.type, item.track)) return;
          const activeTrack = item ? { kind: KIND_OF[sel.type], idx: item.track } : s.activeTrack;
          const family = expand([key]);
          if (mode === 'toggle') {
            if (s.selected.includes(key)) {
              const rest = s.selected.filter((k) => !family.includes(k));
              const last = rest.length ? parseKey(rest[rest.length - 1]) : null;
              const lastItem = last ? findItem(last.type, last.id) : null;
              return set({ selected: rest, selection: last, activeTrack: lastItem ? { kind: KIND_OF[last!.type], idx: lastItem.track } : activeTrack });
            }
            return set({ selected: Array.from(new Set([...s.selected, ...family])), selection: sel, activeTrack, leftTab: 'editor' });
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
              return set({ selected: expand(keys), activeTrack, leftTab: 'editor' });
            }
          }
          set({ selection: sel, selected: family, activeTrack, leftTab: 'editor' });
        },

        selectKeys: (keys, additive = false) => {
          const s = get();
          const unlocked = keys.filter((key) => {
            const p = parseKey(key);
            const item = findItem(p.type, p.id);
            return item && !trackLocked(s, p.type, item.track);
          });
          const all = expand(additive ? Array.from(new Set([...s.selected, ...unlocked])) : unlocked);
          const selection = all.length ? parseKey(all[all.length - 1]) : null;
          const primary = keys.length ? parseKey(keys[keys.length - 1]) : selection;
          const item = primary ? findItem(primary.type, primary.id) : null;
          set({ selected: all, selection, activeTrack: item ? { kind: KIND_OF[primary!.type], idx: item.track } : s.activeTrack });
        },

        selectAll: () => {
          const s = get();
          const keys = [
            ...s.clips.map((c) => keyOf('clip', c.id)),
            ...s.effects.map((c) => keyOf('effect', c.id)),
            ...s.audios.map((c) => keyOf('audio', c.id)),
          ].filter((key) => {
            const p = parseKey(key);
            const item = findItem(p.type, p.id);
            return item && !trackLocked(s, p.type, item.track);
          });
          set({ selected: keys, selection: keys.length ? parseKey(keys[0]) : null });
        },

        addClipFx: (clipId, moduleId) =>
          set((s) => ({
            // 我的組合：主特效與疊加的特效依序變成片段特效（觸發不適用）
            clips: s.clips.map((c) => {
              if (c.id !== clipId) return c;
              const add = comboClipFx(moduleId).map((f) => ({ ...f, timing: defaultTiming(s.modules.find((m) => m.id === f.moduleId)) }));
              return { ...c, effects: [...(c.effects ?? []), ...add] };
            }),
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
              // 片段本身的遮罩不在排序裡：跳過它
              let j = i + dir;
              while (j >= 0 && j < l.length && l[j].base) j += dir;
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
          // 循環範圍（編輯視窗的片段）播完停在結尾：再按播放從頭開始
          if (!s.playing && s.loop && s.time >= s.loop.b - 2 / 60) set({ time: s.loop.a });
          set({ playing: !s.playing });
        },
        setLoop: (l) => set(l ? { loop: l, time: l.a, playing: true } : { loop: null }),
        setPps: (p) => set({ pps: Math.min(PPS_MAX, Math.max(PPS_MIN, p)) }),
        setSnap: (snap) => set({ snap }),
        setLeftTab: (t) => set({ leftTab: t }),

        removeClipAudio: (clipId) => {
          const before = get();
          const clip = before.clips.find((c) => c.id === clipId);
          const media = clip && before.media.find((m) => m.id === clip.mediaId);
          if (!clip || !media?.hasAudio || clip.audioSplit) return false;
          const linkedClips = clip.link ? before.clips.filter((c) => c.link === clip.link) : [];
          const linkedAudios = clip.link ? before.audios.filter((a) => a.link === clip.link) : [];
          const removeLinked = linkedClips.length <= 1;
          if (
            before.tracks.video[clip.track]?.locked ||
            (removeLinked && linkedAudios.some((a) => before.tracks.audio[a.track]?.locked))
          ) return false;
          const removedAudioIds = new Set(removeLinked ? linkedAudios.map((a) => a.id) : []);
          set({
            clips: before.clips.map((c) => c.id === clipId ? { ...c, link: undefined, volume: 0, audioSplit: true } : c),
            audios: removedAudioIds.size ? before.audios.filter((a) => !removedAudioIds.has(a.id)) : before.audios,
            selected: removedAudioIds.size ? before.selected.filter((k) => !removedAudioIds.has(parseKey(k).id)) : before.selected,
            selection: before.selection?.type === 'audio' && removedAudioIds.has(before.selection.id) ? { type: 'clip', id: clip.id } : before.selection,
          });
          return true;
        },
      };
    },
    {
      name: 'ybeat-modules',
      version: 1,
      // 模組（你寫的程式碼）存在 localStorage；專案與素材另外存在 IndexedDB（見 engine/project.ts）
      partialize: (s) => ({ modules: s.modules }),
      merge: (persisted, current) => {
        return { ...current, modules: mergeModules((persisted as { modules?: Module[] })?.modules ?? []) };
      },
    },
  ),
);

/** 存檔（localStorage / 專案 / 匯入）裡的模組 + 目前的內建模組：內建模組的程式碼只在版本相同時沿用存檔的 */
export function mergeModules(saved: Module[]): Module[] {
  const byId = new Map(saved.map((m) => [m.id, m]));
  const modules = BUILTIN_MODULES.map((b) => {
    const m = byId.get(b.id);
    return m && (m.rev ?? 1) === (b.rev ?? 1) ? { ...b, code: m.code } : b;
  });
  // 已經拿掉的內建模組（存檔裡還標著 builtin）不再帶回來
  for (const m of saved) if (!m.builtin && !BUILTIN_MODULES.some((b) => b.id === m.id)) modules.push(m);
  return modules;
}

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
    if (Object.keys(want).length && !trackLocked(s, 'audio', a.track)) aPatch.set(a.id, want);
  }
  for (const a of s.audios) {
    if (!a.link || prevAudios.get(a.id) === a) continue;
    const c = clipByLink.get(a.link);
    if (!c || prevClips.get(c.id) !== c) continue;
    const want: Partial<Clip> = {};
    if (!near(a.start, c.start)) want.start = a.start;
    if (!near(a.duration, c.duration)) want.duration = a.duration;
    if (!near(a.in, c.in)) want.in = a.in;
    if (Object.keys(want).length && !trackLocked(s, 'clip', c.track)) cPatch.set(c.id, want);
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
