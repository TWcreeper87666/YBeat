/** 動畫放到時間軸：吸附到拍、從底下的片段填圖片位置、找空的影片軌 */
import { mediaUsable, uid, useStore, type Clip } from '../store';
import { usePrefs } from '../prefs';
import { animTemplate, type AnimItem } from './animation';
import { POP_VARIANTS, type PopVariant } from './subjectPop';
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

/** 拖曳中的預覽長度：4 拍 */
export const animDropDur = () => beatLenAt(useStore.getState().time) * 4;

/** 範本 / 我的動畫要用幾拍 */
const beatsOf = (item: AnimItem) => Math.max(1, Math.ceil(Math.max(...item.layers.map((l) => l.toBeat), 1) - 1e-6));

/**
 * 在時間軸 time 放一個動畫（source = 範本種類，或 'my:<id>'）。
 * 開頭吸附到最近的一拍；底下有片段：用那一格當主體 / 背景、後面那個鏡頭的第一格當揭露；沒有 = 待補。
 * 放在片段所在的軌道上方第一條空軌（沒有就新增）
 */
export function placeAnim(source: string, track: number, time: number): string | null {
  const s = useStore.getState();
  const grid = triggerBeats(1);
  const snapT = grid.length ? grid.reduce((a, b) => (Math.abs(b - time) < Math.abs(a - time) ? b : a), grid[0]) : time;
  const start = Math.max(0, snapFrame(snapT));
  const beat = beatLenAt(start);
  const preset = source.startsWith('my:') ? usePrefs.getState().animPresets.find((p) => `my:${p.id}` === source) : undefined;
  const variant = (preset ? null : (POP_VARIANTS as string[]).includes(source) ? source : null) as PopVariant | null;
  if (!preset && !variant) return null;
  const nBeats = preset ? beatsOf(preset.item) : 4;
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

  const id = uid();
  let item: AnimItem = preset
    // presetId 留著原本的範本種類（素材庫縮圖、預設名稱用）
    ? { ...structuredClone(preset.item), id, start, duration, track, take: undefined, locked: undefined }
    : animTemplate(variant!, { id, start, duration, track, subject: under?.mediaId ?? null, reveal: next?.mediaId ?? null });
  item.beatTimes = Array.from({ length: nBeats + 1 }, (_, i) => i * beat);
  // 範本：主體 / 背景 / 分身用底下那一格，揭露用下一個鏡頭的第一格
  if (!preset && under) {
    const t0 = srcAt(under, start);
    item = { ...item, slots: item.slots.map((sl) => (sl.role === 'reveal' ? (next ? { ...sl, sourceTime: srcAt(next, end) } : sl) : sl.mediaId ? { ...sl, sourceTime: t0 } : sl)) };
  }
  // 我的動畫：這個專案沒有的素材 → 待補
  if (preset) item = { ...item, slots: item.slots.map((sl) => (sl.mediaId && !media.has(sl.mediaId) ? { ...sl, mediaId: null } : sl)) };

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

/** 把素材放進動畫的某個圖片位置（影片 = 從頭那一格） */
export function setAnimSlot(animId: string, slotId: string, mediaId: string | null) {
  const a = useStore.getState().anims.find((x) => x.id === animId);
  if (!a) return;
  useStore.getState().updateAnim(animId, { slots: a.slots.map((s) => (s.id === slotId ? { ...s, mediaId, sourceTime: 0 } : s)) });
}

