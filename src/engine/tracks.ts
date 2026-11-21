/** 軌道的資料模型與顯示順序（純函式，不依賴 React / zustand，方便測試） */

export type TrackKind = 'video' | 'fx' | 'audio';
export interface TrackState {
  hidden?: boolean;
  muted?: boolean;
  locked?: boolean;
  /** 影片軌：true = 這條軌上的字幕不出現在字幕／歌詞分頁、不匯出 */
  noCaptions?: boolean;
  /** 軌道高度（px），沒設定就用預設 */
  height?: number;
  /** 特效軌：下面有幾條影片軌（特效只作用在它下面的影片軌，跟調整圖層一樣）；沒設定 = 最上層 */
  level?: number;
  /** 音訊軌：上面有幾條影片 / 特效軌（決定它顯示在哪；沒設定 = 在所有影片 / 特效軌下面） */
  row?: number;
}
export const TRACK_H: Record<'video' | 'fx' | 'audio', number> = { video: 58, fx: 38, audio: 50 };
export type Tracks = Record<TrackKind, TrackState[]>;
export const DEFAULT_TRACKS: Tracks = { video: [{}], fx: [{}], audio: [{}] };

/** 特效軌下面有幾條影片軌（0 ~ 影片軌數） */
export function fxLevel(tracks: Tracks, idx: number): number {
  const n = tracks.video.length;
  const l = tracks.fx[idx]?.level;
  return l === undefined ? n : Math.max(0, Math.min(n, l));
}

/** 影片 / 特效軌由上到下的顯示順序（特效軌插在影片軌之間） */
export function visualRows(tracks: Tracks): { kind: 'video' | 'fx'; idx: number }[] {
  const rows: { kind: 'video' | 'fx'; idx: number }[] = [];
  const n = tracks.video.length;
  for (let lv = n; lv >= 0; lv--) {
    tracks.fx
      .map((_, i) => i)
      .filter((i) => fxLevel(tracks, i) === lv)
      .reverse()
      .forEach((i) => rows.push({ kind: 'fx', idx: i }));
    if (lv > 0) rows.push({ kind: 'video', idx: lv - 1 });
  }
  return rows;
}

/** 所有軌道由上到下的顯示順序（音訊軌可以排在影片 / 特效軌之間） */
export function displayRows(tracks: Tracks, upperAt: 'top' | 'bottom'): { kind: TrackKind; idx: number }[] {
  const layered = upperAt === 'top' ? visualRows(tracks) : [...visualRows(tracks)].reverse();
  const L = layered.length;
  const audio = tracks.audio
    .map((t, i) => ({ i, row: Math.max(0, Math.min(L, t.row ?? L)) }))
    .sort((a, b) => a.row - b.row || a.i - b.i);
  const out: { kind: TrackKind; idx: number }[] = [];
  let k = 0;
  for (let p = 0; p <= L; p++) {
    while (k < audio.length && audio[k].row === p) out.push({ kind: 'audio', idx: audio[k++].i });
    if (p < L) out.push(layered[p]);
  }
  return out;
}

/**
 * 依「想要的顯示順序」（由上到下，包含所有軌道）重建軌道：
 * 影片軌編號 = 圖層順序、特效軌 level = 它下面有幾條影片軌、音訊軌 row = 它上面有幾條影片 / 特效軌。
 * 回傳新的軌道設定與每種軌道「舊 index → 新 index」的對照表。
 */
export function tracksFromOrder(
  tracks: Tracks,
  order: { kind: TrackKind; idx: number }[],
  upperAt: 'top' | 'bottom',
): { tracks: Tracks; maps: Record<TrackKind, Map<number, number>> } {
  const maps: Record<TrackKind, Map<number, number>> = { video: new Map(), fx: new Map(), audio: new Map() };
  const next: Tracks = { video: [], fx: [], audio: [] };
  // 影片 / 特效：換成「畫面上方 → 下方」的圖層順序，從最底層往上編號
  const layered = order.filter((r) => r.kind !== 'audio');
  const vis = upperAt === 'top' ? layered : [...layered].reverse();
  let nv = 0;
  for (let i = vis.length - 1; i >= 0; i--) {
    const r = vis[i];
    const st = tracks[r.kind][r.idx] ?? {};
    if (r.kind === 'video') {
      maps.video.set(r.idx, nv++);
      next.video.push(st);
    } else {
      maps.fx.set(r.idx, next.fx.length);
      next.fx.push({ ...st, level: nv });
    }
  }
  // 音訊：row = 顯示順序中它上面有幾條影片 / 特效軌；同一個 row 由上到下編號
  let seen = 0;
  for (const r of order) {
    if (r.kind !== 'audio') { seen++; continue; }
    maps.audio.set(r.idx, next.audio.length);
    next.audio.push({ ...(tracks.audio[r.idx] ?? {}), row: seen });
  }
  return { tracks: next, maps };
}

