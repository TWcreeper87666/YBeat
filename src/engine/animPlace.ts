/** 動畫放到時間軸：吸附到拍、從底下的片段填圖片位置、找空的影片軌 */
import { comboClipFx, mediaUsable, uid, useStore, type Clip, type ClipFx, type Media } from '../store';
import { matteAt, MATTE_SIZE } from './matte';
import { popFraming, scoreMatte } from './subjectPop';
import { usePrefs } from '../prefs';
import { animTemplate, type AnimItem, type AnimSlot } from './animation';
import { POP_VARIANTS, type PopVariant } from './subjectPop';
import { comboBeats, comboItem, isCombo } from './animCombos';
import { triggerBeats } from './trigger';
import { clipSource } from './remap';
import { snapFrame } from './rulerTicks';

/** 一拍幾秒（時間軸 t 附近的節拍格線；沒有 = 0.5 秒） */
function beatLenAt(t: number): number {
  const g = triggerBeats(1);
  if (g.length < 2) return 0.5;
  let i = g.findIndex((b) => b > t);
  if (i <= 0) i = 1;
  if (i >= g.length) i = g.length - 1;
  return Math.max(0.05, g[i] - g[i - 1]);
}

/** 拖曳中的預覽長度（組合動畫照它自己的拍數，其他 4 拍） */
export const animDropDur = (source?: string) => beatLenAt(useStore.getState().time) * (isCombo(source) ? comboBeats(source) : 4);

/** 範本 / 我的動畫要用幾拍 */
const beatsOf = (item: AnimItem) => Math.max(1, Math.ceil(Math.max(...item.layers.map((l) => l.toBeat), 1) - 1e-6));

/**
 * 在時間軸 time 放一個動畫（source = 範本種類，或 'my:<id>'）。
 * 開頭吸附到最近的一拍；底下有片段：用那一格當主體 / 背景、後面那個鏡頭的第一格當揭露；沒有 = 待補。
 * 放在片段所在的軌道上方第一條空軌（沒有就新增）
 */
export function placeAnim(source: string, track: number, time: number): string | null {
  const built = buildAnim(source, track, time);
  if (!built) return null;
  const { item, under } = built;
  const s = useStore.getState();
  const { start, duration, id } = item;
  const end = start + duration;
  // 軌道：底下的片段在同一條軌 / 這條軌這段時間有東西 → 往上找空軌，沒有就新增
  const busy = (tr: number) => [...s.clips, ...s.anims].some((x) => x.track === tr && x.start < end - 1e-6 && x.start + x.duration > start + 1e-6);
  let tr = Math.max(track, under ? under.track + 1 : track);
  while (tr < s.tracks.video.length && (busy(tr) || s.tracks.video[tr]?.locked)) tr++;
  if (tr >= useStore.getState().tracks.video.length) {
    useStore.getState().addTrack('video', useStore.getState().tracks.video.length);
    tr = useStore.getState().tracks.video.length - 1;
  }
  useStore.getState().addAnim({ ...item, track: tr });
  useStore.getState().select({ type: 'anim', id });
  return id;
}

/** 縮放主體時的中心（畫面比例，0 = 正中）：主體的中心，碰到下緣就用下緣；那一格的去背遮罩算好了才知道，沒有 = undefined */
export function subjectCenter(media: Media, sourceTime: number, f: { w: number; h: number } = useStore.getState().format): { cx: number; cy: number } | undefined {
  const m = matteAt(media, media.kind === 'image' ? 0 : sourceTime);
  if (!m) return undefined;
  const sc = scoreMatte(m.data, MATTE_SIZE);
  if (!sc.area) return undefined;
  const { cx, cy } = popFraming(sc, media.width, media.height, f.w, f.h);
  // 主體碰到畫面下緣（半身、腳在畫面外）：以下緣為中心縮放，放大縮小時不會浮起來
  const k = Math.max(f.w / media.width, f.h / media.height), sy = (media.height * k) / f.h;
  const bottom = (sc.bbox[3] - 0.5) * sy;
  return { cx, cy: bottom >= 0.48 ? 0.5 : cy };
}

/**
 * 建立動畫（不放進專案）：placeAnim 和素材庫的「用時間軸畫面試看」共用。
 * snap = 開頭吸附到最近的一拍（試看不吸附，從播放頭開始）
 */
export function buildAnim(source: string, track: number, time: number, snap = true, opts?: { center?: { cx: number; cy: number } }): { item: AnimItem; under?: Clip } | null {
  const s = useStore.getState();
  const grid = triggerBeats(1);
  const snapT = snap && grid.length ? grid.reduce((a, b) => (Math.abs(b - time) < Math.abs(a - time) ? b : a), grid[0]) : time;
  const start = Math.max(0, snapFrame(snapT));
  const beat = beatLenAt(start);
  const preset = source.startsWith('my:') ? usePrefs.getState().animPresets.find((p) => `my:${p.id}` === source) : undefined;
  const variant = (preset ? null : (POP_VARIANTS as string[]).includes(source) ? source : null) as PopVariant | null;
  const combo = !preset && isCombo(source) ? source : null;
  if (!preset && !variant && !combo) return null;
  const nBeats = preset ? beatsOf(preset.item) : combo ? comboBeats(combo) : 4;
  const duration = nBeats * beat;
  const end = start + duration;

  // 底下的片段：同一時間、在別的影片軌上（放在它上面）
  const media = new Map(s.media.map((m) => [m.id, m]));
  const modules = new Map(s.modules.map((m) => [m.id, m]));
  const covering = (t: number, tr?: number) => s.clips.filter((c) => !c.text && (tr === undefined || c.track === tr) && t >= c.start - 1e-6 && t < c.start + c.duration - 1e-6 && mediaUsable(media.get(c.mediaId)));
  const under = covering(start + 1e-3).filter((c) => c.track <= track).sort((a, b) => b.track - a.track)[0] ?? covering(start + 1e-3)[0];
  const srcAt = (c: Clip, t: number) => {
    const m = media.get(c.mediaId)!;
    return m.kind === 'video' ? clipSource(c, Math.max(0, t - c.start), m, modules).src : 0;
  };
  const next = under ? covering(end + 1e-3, under.track)[0] : undefined;
  // 縮放以主體為中心（不然主體會往畫面中間飄）：試看直接給；放到時間軸時看底下那一格的去背遮罩算好了沒
  const center = opts?.center ?? (under ? subjectCenter(media.get(under.mediaId)!, srcAt(under, start)) : undefined);

  const id = uid();
  let item: AnimItem = preset
    // presetId 留著原本的範本種類（素材庫縮圖、預設名稱用）
    ? { ...structuredClone(preset.item), id, start, duration, track, take: undefined, locked: undefined }
    : combo
      ? comboItem(combo, { id, start, duration, track, center,
        under: under && { mediaId: under.mediaId, sourceTime: srcAt(under, start) },
        next: next && { mediaId: next.mediaId, sourceTime: srcAt(next, end) } })
    : animTemplate(variant!, { id, start, duration, track, subject: under?.mediaId ?? null, reveal: next?.mediaId ?? null,
      cx: center?.cx, cy: center?.cy, ...(variant === 'textBehind' ? { text: 'TEXT' } : {}) });
  item.beatTimes = Array.from({ length: nBeats + 1 }, (_, i) => i * beat);
  // 範本：主體 / 背景 / 分身用底下那一格，揭露用下一個鏡頭的第一格
  if (!preset && !combo && under) {
    const t0 = srcAt(under, start);
    item = { ...item, slots: item.slots.map((sl) => (sl.role === 'reveal' ? (next ? { ...sl, sourceTime: srcAt(next, end) } : sl) : sl.mediaId ? { ...sl, sourceTime: t0 } : sl)) };
  }
  // 我的動畫：這個專案沒有的素材 → 待補
  if (preset) item = { ...item, slots: item.slots.map((sl) => (sl.mediaId && !media.has(sl.mediaId) ? { ...sl, mediaId: null } : sl)) };
  return { item, under };
}

/** 圖片位置（文字以外） */
export const imageSlots = (a: AnimItem) => a.slots.filter((s) => s.role !== 'other');

/** 屬性面板列出的圖片位置：有圖層在畫、或拿來當遮罩輪廓的（文字以外） */
export function usedImageSlots(a: AnimItem): AnimSlot[] {
  const used = new Set(a.layers.flatMap((l) => [l.slotId, ...(l.mask ? [l.mask.slotId] : [])]));
  return a.slots.filter((s) => used.has(s.id) && s.role !== 'other');
}

// ───────────── 複製 / 貼上圖片 ─────────────

type SlotImage = Pick<AnimSlot, 'mediaId' | 'sourceTime' | 'crop' | 'cutout'>;
/** 複製的圖片列表（照屬性面板的順序，空的位置不算） */
export interface SlotClip { slots: { role: AnimSlot['role']; image: SlotImage }[] }

const imageOf = (s: AnimSlot): SlotImage => ({ mediaId: s.mediaId, sourceTime: s.sourceTime,
  ...(s.crop ? { crop: structuredClone(s.crop) } : {}), ...(s.cutout ? { cutout: { ...s.cutout } } : {}) });

export function copySlots(slots: AnimSlot[]): SlotClip {
  return { slots: slots.filter((s) => s.mediaId).map((s) => ({ role: s.role, image: imageOf(s) })) };
}

/**
 * 貼上圖片列表（純函式）：
 * - 主體依序對主體；來源的人比較少就從頭輪流（一個人貼到三人範本 = 三個都是他）。offset = 前面的動畫已經用掉幾個人（多選依序分配）
 * - 背景 / 揭露各自對同一種；分身優先對分身，沒有就跟著這次貼上的那個主體；對不到的保留原本的
 * - 「全用同一張」的目標：全部用第一張（主體優先）
 * - 去背開關只在同一種位置之間帶過去（背景的設定不套到人身上）；素材不在專案裡的略過
 */
export function pasteSlots(target: AnimItem, clip: SlotClip, opts: { usable: (mediaId: string) => boolean; offset?: number }): { slots: AnimSlot[]; used: number } {
  const ok = clip.slots.filter((s) => s.image.mediaId && opts.usable(s.image.mediaId));
  const pool = (role: AnimSlot['role']) => ok.filter((s) => s.role === role).map((s) => s.image);
  const subjects = pool('subject'), copies = pool('copy'), backs = pool('background'), reveals = pool('reveal');
  const shown = new Set(usedImageSlots(target).map((s) => s.id));
  const set = (s: AnimSlot, img: SlotImage | undefined, sameRole: boolean): AnimSlot => !img ? s : {
    ...s, mediaId: img.mediaId, sourceTime: img.sourceTime, crop: img.crop && structuredClone(img.crop),
    ...(sameRole && img.cutout && s.cutout ? { cutout: { ...s.cutout, mode: img.cutout.mode, edit: img.cutout.edit } } : {}),
  };
  if (target.sameMedia) {
    const first = subjects[0] ?? backs[0] ?? reveals[0] ?? copies[0];
    return { slots: target.slots.map((s) => (s.role === 'other' ? s : set(s, first, false))), used: 0 };
  }
  const off = opts.offset ?? 0;
  const nth: Partial<Record<AnimSlot['role'], number>> = {};
  const pickedSubject: SlotImage[] = [];
  let used = 0;
  // 先排主體（分身要跟著這次貼上的主體）
  const order = [...target.slots].sort((a, b) => Number(b.role === 'subject') - Number(a.role === 'subject'));
  const out = new Map<string, AnimSlot>();
  for (const s of order) {
    if (s.role === 'other' || !shown.has(s.id)) { out.set(s.id, s); continue; }
    const i = (nth[s.role] = (nth[s.role] ?? -1) + 1);
    let img: SlotImage | undefined, same = true;
    if (s.role === 'subject') {
      img = subjects.length ? subjects[(off + i) % subjects.length] : undefined;
      if (img) { pickedSubject.push(img); used++; }
    } else if (s.role === 'copy') {
      img = copies[i];
      if (!img) { img = pickedSubject[i % Math.max(1, pickedSubject.length)]; same = false; }
    } else img = (s.role === 'background' ? backs : reveals)[i];
    out.set(s.id, set(s, img, same));
  }
  return { slots: target.slots.map((s) => out.get(s.id)!), used };
}

let slotClipboard: SlotClip | null = null;
/** 複製了幾張（沒有 = 0） */
export const slotClipboardCount = () => slotClipboard?.slots.length ?? 0;

/** 複製一個動畫的圖片列表（只有 slotId = 只複製那一列） */
export function copyAnimImages(animId: string, slotId?: string): boolean {
  const a = useStore.getState().anims.find((x) => x.id === animId);
  if (!a) return false;
  const clip = copySlots(usedImageSlots(a).filter((s) => !slotId || s.id === slotId));
  if (!clip.slots.length) return false;
  slotClipboard = clip;
  return true;
}

/**
 * 貼上圖片到這些動畫（一次復原）；有 slotId = 只換那一列（用複製的第一張）。
 * 多個動畫：照開始時間排，主體依序分下去。回傳貼了幾個動畫。
 */
export function pasteAnimImages(animIds: string[], slotId?: string): number {
  const clip = slotClipboard;
  if (!clip?.slots.length) return 0;
  const s = useStore.getState();
  const media = new Map(s.media.map((m) => [m.id, m]));
  const usable = (id: string) => mediaUsable(media.get(id));
  const targets = s.anims.filter((a) => animIds.includes(a.id) && !s.tracks.video[a.track]?.locked)
    .sort((a, b) => a.start - b.start || a.track - b.track || a.id.localeCompare(b.id));
  const patches: Record<string, Partial<AnimItem>> = {};
  let offset = 0;
  for (const a of targets) {
    if (slotId) {
      const img = clip.slots.find((x) => x.image.mediaId && usable(x.image.mediaId));
      if (!img || !a.slots.some((x) => x.id === slotId)) continue;
      const share = { mediaId: img.image.mediaId, sourceTime: img.image.sourceTime, crop: img.image.crop && structuredClone(img.image.crop) };
      patches[`anim:${a.id}`] = { slots: a.slots.map((x) => x.id === slotId
        ? { ...x, ...share, ...(img.role === x.role && img.image.cutout && x.cutout ? { cutout: { ...x.cutout, mode: img.image.cutout.mode, edit: img.image.cutout.edit } } : {}) }
        : a.sameMedia && x.role !== 'other' ? { ...x, ...share } : x) };
      continue;
    }
    const r = pasteSlots(a, clip, { usable, offset });
    offset += r.used;
    patches[`anim:${a.id}`] = { slots: r.slots };
  }
  if (!Object.keys(patches).length) return 0;
  useStore.getState().patchItems(patches);
  return Object.keys(patches).length;
}

/** 改某個圖片位置；「全用同一張」時素材、那一格、裁切套到所有圖片位置 */
export function patchAnimSlot(animId: string, slotId: string, p: Partial<AnimSlot>) {
  const a = useStore.getState().anims.find((x) => x.id === animId);
  if (!a) return;
  const shared: Partial<AnimSlot> = {};
  for (const k of ['mediaId', 'sourceTime', 'crop'] as const) if (k in p) (shared as Record<string, unknown>)[k] = p[k];
  const all = a.sameMedia && Object.keys(shared).length > 0;
  useStore.getState().updateAnim(animId, { slots: a.slots.map((s) => (s.id === slotId ? { ...s, ...p }
    : all && s.role !== 'other' ? { ...s, ...shared } : s)) });
}

/** 打開「全用同一張」：其他圖片位置都換成 from 這一格（沒指定 = 第一個有素材的） */
export function setAnimSameMedia(animId: string, on: boolean, fromSlotId?: string) {
  const a = useStore.getState().anims.find((x) => x.id === animId);
  if (!a) return;
  if (!on) return useStore.getState().updateAnim(animId, { sameMedia: undefined });
  const src = (fromSlotId ? a.slots.find((s) => s.id === fromSlotId) : undefined) ?? imageSlots(a).find((s) => s.mediaId) ?? imageSlots(a)[0];
  useStore.getState().updateAnim(animId, { sameMedia: true, slots: src ? a.slots.map((s) => (s.role === 'other' ? s
    : { ...s, mediaId: src.mediaId, sourceTime: src.sourceTime, crop: src.crop })) : a.slots });
}

/** 把素材放進動畫的某個圖片位置（影片 = 從頭那一格） */
export function setAnimSlot(animId: string, slotId: string, mediaId: string | null) {
  patchAnimSlot(animId, slotId, { mediaId, sourceTime: 0 });
}


/** 圖層加特效（我的組合 = 主特效 + 疊加的特效依序加上） */
export function addAnimLayerFx(animId: string, layerId: string, moduleId: string) {
  const a = useStore.getState().anims.find((x) => x.id === animId);
  if (!a?.layers.some((l) => l.id === layerId)) return;
  const add = comboClipFx(moduleId).map((f: ClipFx) => ({ ...f, id: uid() }));
  useStore.getState().updateAnim(animId, { layers: a.layers.map((l) => (l.id === layerId ? { ...l, effects: [...(l.effects ?? []), ...add] } : l)) });
}
