/**
 * 使用者調整過的能量曲線：分析出來的每拍能量 → 加上整體強度、對比、控制點的偏移 → 重新分低 / 中 / 高。
 * 段落邊界、drop、重音照分析結果，不受影響（剪接點還是落在一樣的地方，只是密度、點綴跟著新的能量）。
 */
import type { MusicInfo } from './musicAnalysis';

export interface EnergyShape {
  /** 整體上移 / 下移（-0.5..0.5） */
  gain: number;
  /** 對比（0.5..2）：以 0.6 為中心拉開 / 壓縮 */
  contrast: number;
  /** 控制點：x = 位置（0..1，範圍內的比例）、y = 偏移（-1..1）；第一個 x = 0、最後一個 x = 1，依 x 排序 */
  points: { x: number; y: number }[];
}

export const FLAT_SHAPE = (): EnergyShape => ({ gain: 0, contrast: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] });
/** 跟分析時一樣的門檻 */
export const LOW_MAX = 0.45, MID_MAX = 0.75;

export const isFlat = (s: EnergyShape) => s.gain === 0 && s.contrast === 1 && s.points.every((p) => p.y === 0);

/** 控制點在 x 的偏移（線性內插；沒有點 = 0） */
export function offsetAt(points: EnergyShape['points'], x: number): number {
  if (!points.length) return 0;
  if (x <= points[0].x) return points[0].y;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (x <= b.x) return b.x - a.x < 1e-9 ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return points[points.length - 1].y;
}

/** 單一拍的能量（i / n = 位置） */
export const shapeValue = (e: number, x: number, s: EnergyShape) => Math.min(1, Math.max(0, 0.6 + (e - 0.6) * s.contrast + s.gain + offsetAt(s.points, x) * 0.6));

/**
 * 套用曲線：range = 控制點對應的拍號範圍（預設整首）。範圍外的拍只套整體強度和對比。
 */
export function shapeMusic(info: MusicInfo, s: EnergyShape, range: [number, number] = [0, info.energy.length]): MusicInfo {
  if (isFlat(s)) return info;
  const [b0, b1] = range;
  const span = Math.max(1, b1 - b0);
  const energy = info.energy.map((e, i) => {
    const x = Math.min(1, Math.max(0, (i - b0) / span));
    return i < b0 || i >= b1 ? shapeValue(e, x, { ...s, points: [] }) : shapeValue(e, x, s);
  });
  const level = energy.map((e) => (e < LOW_MAX ? 0 : e < MID_MAX ? 1 : 2) as 0 | 1 | 2);
  const sections = info.sections.map((sec) => {
    let sum = 0;
    for (let i = sec.b0; i < sec.b1; i++) sum += energy[i] ?? 0;
    return { ...sec, energy: sec.b1 > sec.b0 ? sum / (sec.b1 - sec.b0) : 0 };
  });
  return { ...info, energy, level, sections };
}
