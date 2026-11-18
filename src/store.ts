import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { BUILTIN_MODULES, NEW_MODULE_TEMPLATES, type Module, type ModuleKind } from './modules/builtin';
import { parseDuration, type ParamValues } from './engine/params';
import { clipSource } from './engine/remap';
import { DEFAULT_TRANSFORM, EASES, type EaseName, type Fit, type Transform } from './engine/transform';
import { ANIM_PROPS, newKey, scaleKeyMap, splitKeys, type Ease, type Keyframe, type Keys } from './engine/keyframes';

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

export interface Clip {
  id: string;
  mediaId: string;
  track: number;
  start: number;
  duration: number;
  in: number;
  remap: { moduleId: string; params: ParamValues };
  transitionIn: TransitionRef | null;
  fit: Fit;
  flipX: boolean;
  /** 沒有關鍵影格時的固定值 */
  transform: Transform;
  /** 關鍵影格（片段內時間） */
  keys: Keys;
  volume: number;
  /** 整體播放速率（Ctrl+拖曳邊緣調整；一般變速模組會直接改它的 speed 參數） */
  rate: number;
  /** 舊版欄位，載入時會轉成 keys */
  transformEnd?: Transform | null;
  ease?: EaseName;
}

export interface FxItem {
  id: string;
  moduleId: string;
  params: ParamValues;
  /** 數值參數的關鍵影格（特效內時間） */
  keys?: Record<string, Keyframe[]>;
  start: number;
  duration: number;
  track: number;
}

export interface AudioClip {
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
}

export type TrackKind = 'video' | 'fx' | 'audio';
export interface TrackState { hidden?: boolean; muted?: boolean }
export type Tracks = Record<TrackKind, TrackState[]>;
export const DEFAULT_TRACKS: Tracks = { video: [{}, {}], fx: [{}, {}], audio: [{}] };

export type ItemType = 'clip' | 'effect' | 'audio';
export type AnyItem = Clip | FxItem | AudioClip;
export type Selection = { type: ItemType | 'transition' | 'module'; id: string } | null;
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

  addMedia(m: Media): void;
  addClip(mediaId: string, start?: number, track?: number): void;
  addAudio(mediaId: string, start?: number, track?: number): void;
  updateClip(id: string, patch: Partial<Clip>): void;
  updateAudio(id: string, patch: Partial<AudioClip>): void;
  patchItems(patches: Record<string, Partial<AnyItem>>): void;
  setTransition(clipId: string, moduleId: string | null): void;
  updateTransition(clipId: string, patch: Partial<TransitionRef>): void;
  setRemap(clipId: string, moduleId: string): void;
  addEffect(moduleId: string, start: number, track?: number): void;
  updateEffect(id: string, patch: Partial<FxItem>): void;
  relinkMedia(oldId: string, newId: string): void;
  removeSelection(ripple?: boolean): void;
  split(): void;
  trim(side: 'start' | 'end'): void;
  nudge(dt: number): void;
  copy(): void;
  cut(): void;
  paste(at?: { time: number; track: number; kind: TrackKind }): void;
  duplicate(): void;
  addTrack(kind: TrackKind, at?: number): void;
  moveTrack(kind: TrackKind, from: number, to: number): void;
  deleteTrack(kind: TrackKind, idx: number): boolean;
  toggleTrack(kind: TrackKind, idx: number, key: 'hidden' | 'muted'): void;
  select(sel: Selection, mode?: SelectMode): void;
  selectKeys(keys: string[], additive?: boolean): void;
  selectAll(): void;
  updateModuleCode(id: string, code: string): void;
  renameModule(id: string, name: string): void;
  forkModule(id: string): string;
  resetModule(id: string): void;
  createModule(kind: ModuleKind): string;
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
          return [
            { ...c, duration: local, keys: ka },
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
          add[LIST[type]].push(n);
          keys.push(keyOf(type, n.id));
        }
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
        exporting: null,

        addMedia: (m) => set((s) => ({ media: [...s.media, m] })),

        addClip: (mediaId, start, track = 0) => {
          const s = get();
          const media = s.media.find((m) => m.id === mediaId);
          if (!mediaUsable(media)) return;
          if (media.kind === 'audio') return s.addAudio(mediaId, start);
          track = Math.min(track, s.tracks.video.length - 1);
          const clip = makeClip({
            mediaId,
            track,
            start: start ?? trackEnd(s.clips, track),
            duration: media.kind === 'video' ? Math.min(media.duration, 6) : 2,
          });
          set({ clips: [...s.clips, clip], selection: { type: 'clip', id: clip.id }, selected: [keyOf('clip', clip.id)], leftTab: 'editor' });
        },

        addAudio: (mediaId, start, track = 0) => {
          const s = get();
          const media = s.media.find((m) => m.id === mediaId);
          if (!mediaUsable(media) || !media.hasAudio) return;
          track = Math.min(track, s.tracks.audio.length - 1);
          const a = makeAudio({ mediaId, track, start: start ?? trackEnd(s.audios, track), duration: media.duration });
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

        setTransition: (clipId, moduleId) =>
          set((s) => ({
            clips: s.clips.map((c) =>
              c.id === clipId
                ? {
                    ...c,
                    transitionIn: moduleId
                      ? { moduleId, params: c.transitionIn?.moduleId === moduleId ? c.transitionIn.params : {}, duration: c.transitionIn?.duration ?? 0.4 }
                      : null,
                  }
                : c,
            ),
            selection: moduleId ? { type: 'transition', id: clipId } : { type: 'clip', id: clipId },
            selected: moduleId ? [] : [keyOf('clip', clipId)],
            leftTab: 'editor',
          })),

        updateTransition: (clipId, patch) =>
          set((s) => ({
            clips: s.clips.map((c) => (c.id === clipId && c.transitionIn ? { ...c, transitionIn: { ...c.transitionIn, ...patch } } : c)),
          })),

        setRemap: (clipId, moduleId) =>
          set((s) => ({
            clips: s.clips.map((c) => (c.id === clipId ? { ...c, remap: { moduleId, params: {} } } : c)),
            selection: { type: 'clip', id: clipId },
            selected: [keyOf('clip', clipId)],
            leftTab: 'editor',
          })),

        addEffect: (moduleId, start, track = 0) => {
          const m = get().modules.find((x) => x.id === moduleId);
          if (!m) return;
          const fx: FxItem = { id: uid(), moduleId, params: {}, start: Math.max(0, start), duration: parseDuration(m.code, 0.5), track };
          set((s) => ({ effects: [...s.effects, fx], selection: { type: 'effect', id: fx.id }, selected: [keyOf('effect', fx.id)], leftTab: 'editor' }));
        },

        updateEffect: (id, patch) => set((s) => ({ effects: s.effects.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),

        relinkMedia: (oldId, newId) =>
          set((s) => ({
            clips: s.clips.map((c) => (c.mediaId === oldId ? { ...c, mediaId: newId } : c)),
            audios: s.audios.map((a) => (a.mediaId === oldId ? { ...a, mediaId: newId } : a)),
            media: s.media.filter((m) => !(m.id === oldId && m.missing)),
          })),

        removeSelection: (ripple = false) => {
          const s = get();
          const sel = s.selection;
          if (sel?.type === 'transition') return s.setTransition(sel.id, null);
          if (sel?.type === 'module') {
            const m = s.modules.find((x) => x.id === sel.id);
            const used =
              s.clips.some((c) => c.remap.moduleId === sel.id || c.transitionIn?.moduleId === sel.id) || s.effects.some((e) => e.moduleId === sel.id);
            if (!m || m.builtin || used) return;
            return set({ modules: s.modules.filter((x) => x.id !== sel.id), selection: null });
          }
          const dels = targets()
            .map(({ type, id }) => ({ type, it: findItem(type, id) }))
            .filter((d): d is { type: ItemType; it: AnyItem } => !!d.it)
            .sort((a, b) => b.it.start - a.it.start); // 從後面刪，波紋位移才不會互相干擾
          if (!dels.length) return;
          const lists: Record<string, AnyItem[]> = { clips: s.clips, effects: s.effects, audios: s.audios };
          for (const { type, it } of dels) {
            const key = LIST[type];
            const end = it.start + it.duration;
            let l = lists[key].filter((x) => x.id !== it.id);
            if (ripple) l = l.map((x) => (x.track === it.track && x.start >= end - 1e-3 ? { ...x, start: Math.max(0, x.start - it.duration) } : x));
            lists[key] = l;
          }
          set({ clips: lists.clips as Clip[], effects: lists.effects as FxItem[], audios: lists.audios as AudioClip[], selection: null, selected: [] });
        },

        split: () => {
          const t = get().time;
          const list = cutTargets();
          if (!list.length) return;
          const s = get();
          const lists: Record<string, AnyItem[]> = { clips: s.clips, effects: s.effects, audios: s.audios };
          const newKeys: string[] = [];
          for (const { type, id } of list) {
            const key = LIST[type];
            const it = lists[key].find((x) => x.id === id)!;
            const [a, b] = splitOne(type, it, t);
            lists[key] = lists[key].flatMap((x) => (x.id === id ? [a, b] : [x]));
            newKeys.push(keyOf(type, b.id));
          }
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
          const patches: Record<string, Partial<AnyItem>> = {};
          for (const { type, id } of list) {
            const it = findItem(type, id);
            if (it) patches[keyOf(type, id)] = { start: Math.max(0, it.start + dt) };
          }
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

        addTrack: (kind, at) =>
          set((s) => {
            const n = s.tracks[kind].length;
            const i = Math.max(0, Math.min(n, at ?? n));
            const list = [...s.tracks[kind]];
            list.splice(i, 0, {});
            const shift = <T extends AnyItem>(items: T[]) => items.map((x) => (x.track >= i ? { ...x, track: x.track + 1 } : x));
            return {
              tracks: { ...s.tracks, [kind]: list },
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
              tracks: { ...s.tracks, [kind]: order.map((o) => s.tracks[kind][o]) },
              ...(kind === 'video' ? { clips: remap(s.clips) } : kind === 'fx' ? { effects: remap(s.effects) } : { audios: remap(s.audios) }),
            };
          }),

        deleteTrack: (kind, idx) => {
          const s = get();
          const list = kind === 'video' ? s.clips : kind === 'fx' ? s.effects : s.audios;
          if (s.tracks[kind].length <= 1 || list.some((x) => x.track === idx)) return false;
          const shift = <T extends AnyItem>(items: T[]) => items.map((x) => (x.track > idx ? { ...x, track: x.track - 1 } : x));
          set({
            tracks: { ...s.tracks, [kind]: s.tracks[kind].filter((_, i) => i !== idx) },
            ...(kind === 'video' ? { clips: shift(s.clips) } : kind === 'fx' ? { effects: shift(s.effects) } : { audios: shift(s.audios) }),
          });
          return true;
        },
        toggleTrack: (kind, idx, key) =>
          set((s) => ({ tracks: { ...s.tracks, [kind]: s.tracks[kind].map((t, i) => (i === idx ? { ...t, [key]: !t[key] } : t)) } })),

        select: (sel, mode = 'replace') => {
          if (!sel) return set({ selection: null, selected: [] });
          if (!isItem(sel.type)) return set({ selection: sel, selected: [], leftTab: 'editor' });
          const s = get();
          const key = keyOf(sel.type, sel.id);
          if (mode === 'toggle') {
            if (s.selected.includes(key)) {
              const rest = s.selected.filter((k) => k !== key);
              return set({ selected: rest, selection: rest.length ? parseKey(rest[rest.length - 1]) : null });
            }
            return set({ selected: [...s.selected, key], selection: sel, leftTab: 'editor' });
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
              return set({ selected: keys, leftTab: 'editor' });
            }
          }
          set({ selection: sel, selected: [key], leftTab: 'editor' });
        },

        selectKeys: (keys, additive = false) => {
          const s = get();
          const all = additive ? Array.from(new Set([...s.selected, ...keys])) : keys;
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

        updateModuleCode: (id, code) => set((s) => ({ modules: s.modules.map((m) => (m.id === id ? { ...m, code } : m)) })),
        renameModule: (id, name) => set((s) => ({ modules: s.modules.map((m) => (m.id === id ? { ...m, name } : m)) })),

        forkModule: (id) => {
          const m = get().modules.find((x) => x.id === id);
          if (!m) return id;
          const copy: Module = { id: `${m.kind}-${uid()}`, kind: m.kind, name: `${m.name}（副本）`, code: m.code };
          set((s) => ({ modules: [...s.modules, copy] }));
          return copy.id;
        },

        resetModule: (id) => {
          const b = BUILTIN_MODULES.find((x) => x.id === id);
          if (b) set((s) => ({ modules: s.modules.map((m) => (m.id === id ? { ...b } : m)) }));
        },

        createModule: (kind) => {
          const names = { effect: '新特效', transition: '新轉場', remap: '新變速' };
          const m: Module = { id: `${kind}-${uid()}`, kind, name: names[kind], code: NEW_MODULE_TEMPLATES[kind] };
          set((s) => ({ modules: [...s.modules, m], selection: { type: 'module', id: m.id }, selected: [], leftTab: 'editor' }));
          return m.id;
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
      name: 'beatsync-modules',
      version: 1,
      // 模組（你寫的程式碼）存在 localStorage；專案與素材另外存在 IndexedDB（見 engine/project.ts）
      partialize: (s) => ({ modules: s.modules }),
      merge: (persisted, current) => {
        const saved: Module[] = (persisted as { modules?: Module[] })?.modules ?? [];
        const byId = new Map(saved.map((m) => [m.id, m]));
        const modules = BUILTIN_MODULES.map((b) => (byId.has(b.id) ? { ...b, code: byId.get(b.id)!.code } : b));
        for (const m of saved) if (!BUILTIN_MODULES.some((b) => b.id === m.id)) modules.push(m);
        return { ...current, modules };
      },
    },
  ),
);
