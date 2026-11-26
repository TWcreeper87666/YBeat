import type { ParamValues } from '../engine/params';
import type { FxTrigger } from '../engine/trigger';
import type { FxCombo } from '../prefs';

/**
 * 內建的特效組合（特效素材庫的「組合」）：常見 edit 風格的主特效 + 疊加特效。
 * 衝擊型（短、放在 drop / 剪接點上）、節拍型（整段每拍重播）、氛圍型（整段放著）。
 * name 是中文原文，顯示時用 displayName 翻譯。
 */
export const BUILTIN_COMBO_PREFIX = 'combo:builtin-';
export const isBuiltinCombo = (id: string) => id.startsWith(BUILTIN_COMBO_PREFIX);

type Fx = [moduleId: string, params: ParamValues];

function combo(id: string, name: string, duration: number, [moduleId, params]: Fx, stack: Fx[] = [], trigger?: FxTrigger): FxCombo {
  return {
    id: BUILTIN_COMBO_PREFIX + id,
    name,
    builtin: true,
    fx: {
      moduleId,
      params,
      duration,
      ...(stack.length ? { stack: stack.map(([m, p], i) => ({ id: `${id}-${i}`, moduleId: m, params: p })) } : {}),
      ...(trigger ? { trigger } : {}),
    },
  };
}

export const BUILTIN_COMBOS: FxCombo[] = [
  // ── 衝擊 ──
  combo('velocity', '變速重擊', 0.4, ['fx-crashzoom', { amount: 0.85, blur: 0.55 }], [
    ['fx-shakeblur', { strength: 0.045, blur: 0.8, decay: 3 }],
    ['fx-flash', { intensity: 0.7, decay: 5 }],
  ]),
  combo('bassdrop', '重低音', 0.5, ['fx-zoompulse', { amount: 0.24, blur: 0.35 }], [
    ['fx-shake', { strength: 0.065, rotation: 0.08, freq: 38, decay: 3 }],
    ['fx-rgb', { amount: 0.025, decay: 3 }],
  ]),
  combo('anime', '動漫衝擊', 0.6, ['fx-shockwave', { strength: 0.1, width: 0.1, radius: 1.35, rgb: 0.55 }], [
    ['fx-speedlines', { count: 130, thickness: 0.28, speed: 25, opacity: 0.65 }],
    ['fx-flash', { intensity: 0.9, decay: 5 }],
  ]),
  combo('glitchcut', '故障切點', 0.4, ['fx-glitch', { amount: 0.68, slices: 32, speed: 42, rgb: 0.035, decay: 3 }], [
    ['fx-twitch', { amount: 0.35, speed: 24, zoom: 0.1, offset: 0.025, decay: 4 }],
  ]),
  combo('flashback', '閃白回憶', 0.45, ['fx-flash', { intensity: 1.55, decay: 5 }], [
    ['fx-blurpulse', { amount: 0.055, zoom: 0.07 }],
    ['fx-bw', { contrast: 1.45, amount: 0.75, decay: 4 }],
  ]),
  combo('spindrop', '旋轉落拍', 0.45, ['fx-spinkick', { angle: 24, blur: 0.85, zoom: 0.22 }], [
    ['fx-motionblur', { amount: 0.1, angle: 25, decay: 3 }],
    ['fx-rgb', { amount: 0.018, decay: 3 }],
  ]),
  combo('slice', '切片跳格', 0.4, ['fx-slice', { count: 9, amount: 0.38, blur: 0.4 }], [
    ['fx-pixelate', { size: 24, decay: 4 }],
    ['fx-flash', { intensity: 0.45, decay: 6 }],
  ]),
  combo('chromadrop', '色散墜落', 0.5, ['fx-chromazoom', { amount: 0.13, zoom: 0.18 }], [
    ['fx-zoomecho', { copies: 4, spread: 0.12, opacity: 0.35 }],
    ['fx-shake', { strength: 0.035, rotation: 0.04, freq: 26, decay: 3 }],
  ]),
  combo('jelly', '果凍彈跳', 0.6, ['fx-squash', { amount: 0.24, bounces: 1.5, damping: 6, vertical: true }], [
    ['fx-zoompulse', { amount: 0.12, blur: 0.2 }],
    ['fx-flash', { intensity: 0.35, decay: 6 }],
  ]),
  combo('invertpunch', '反相衝擊', 0.3, ['fx-invert', { amount: 1, decay: 3 }], [
    ['fx-crashzoom', { amount: 0.5, blur: 0.4 }],
    ['fx-shake', { strength: 0.05, rotation: 0.06, freq: 40, decay: 3 }],
  ]),
  combo('whip3d', '3D 甩動', 0.6, ['fx-tilt3d', { tiltY: 35, swings: 1, damping: 5, zoom: 1.15 }], [
    ['fx-motionblur', { amount: 0.08, angle: 0, decay: 3 }],
    ['fx-chromazoom', { amount: 0.06, zoom: 0.05 }],
  ]),

  // ── 節拍（整段每拍重播）──
  combo('beatbounce', '每拍彈跳', 4, ['fx-zoompulse', { amount: 0.12, blur: 0.3 }], [
    ['fx-rgb', { amount: 0.012, decay: 3 }],
  ], { kind: 'beat', every: 1 }),
  combo('beatflash', '節拍閃光', 4, ['fx-flash', { intensity: 0.6, decay: 6 }], [
    ['fx-blurpulse', { amount: 0.025, zoom: 0.04 }],
  ], { kind: 'beat', every: 1 }),
  combo('glitchgroove', '故障節拍', 4, ['fx-twitch', { amount: 0.5, speed: 20, decay: 3 }], [
    ['fx-rgb', { amount: 0.02, decay: 3 }],
  ], { kind: 'beat', every: 0.5, chance: 0.5, seed: 7 }),

  // ── 氛圍 ──
  combo('cinematic', '電影感', 5, ['fx-grade', { contrast: 1.22, saturation: 0.88, vignette: 0.28, tint: '#c7d9e8' }], [
    ['fx-letterbox', { size: 0.1 }],
    ['fx-grain', { amount: 0.07 }],
  ]),
  combo('dreamy', '夢幻柔光', 4, ['fx-glow', { threshold: 0.68, intensity: 1.65, radius: 0.045, tint: '#ffe6f5' }], [
    ['fx-grade', { contrast: 0.88, saturation: 1.12, vignette: 0.16, tint: '#fff0f7' }],
    ['fx-handheld', { strength: 0.006, rotation: 0.005, speed: 0.35, zoom: 1.03 }],
  ]),
  combo('vhs', '錄影帶回憶', 5, ['fx-vhs', { lines: 480, grain: 0.13, bleed: 0.007, jitter: 0.005 }], [
    ['fx-grade', { contrast: 0.9, saturation: 0.82, vignette: 0, tint: '#ffe2c7' }],
    ['fx-vignette', { amount: 0.38, size: 0.62, softness: 0.75 }],
  ]),
  combo('warmfilm', '暖調底片', 6, ['fx-grain', { amount: 0.16, size: 2.2 }], [
    ['fx-grade', { contrast: 0.92, saturation: 0.9, vignette: 0.22, tint: '#ffd8ad' }],
    ['fx-handheld', { strength: 0.009, rotation: 0.008, speed: 0.55, jitter: 0.18, zoom: 1.04 }],
  ]),
  combo('memory', '朦朧回憶', 4, ['fx-grade', { contrast: 0.9, saturation: 0.6, vignette: 0.5, tint: '#ffe8d0' }], [
    ['fx-glow', { threshold: 0.5, intensity: 1, radius: 0.04 }],
    ['fx-grain', { amount: 0.08 }],
  ]),
  combo('noir', '黑白電影', 4, ['fx-bw', { contrast: 2.15, amount: 1, decay: 0 }], [
    ['fx-vignette', { amount: 0.62, size: 0.42, softness: 0.72 }],
    ['fx-grain', { amount: 0.11, size: 1.8 }],
  ]),
  combo('tension', '緊張感', 4, ['fx-grade', { contrast: 1.3, saturation: 0.55, vignette: 0.5, tint: '#d8e4ff' }], [
    ['fx-handheld', { strength: 0.02, rotation: 0.015, speed: 1.5, jitter: 0.6, zoom: 1.06 }],
    ['fx-grain', { amount: 0.09 }],
  ]),
  combo('neon', '霓虹夜', 4, ['fx-duotone', { shadow: '#10102d', highlight: '#ff4f9a', contrast: 1.35, strength: 0.78 }], [
    ['fx-glow', { threshold: 0.75, intensity: 1.35, radius: 0.025, tint: '#ff4fba' }],
    ['fx-vignette', { amount: 0.42, size: 0.55, softness: 0.7 }],
  ]),
  combo('prism', '稜鏡幻覺', 4, ['fx-kaleido', { segments: 6, spin: 0.22, zoom: 1.15 }], [
    ['fx-glow', { threshold: 0.7, intensity: 1.1, radius: 0.035, tint: '#d7c5ff' }],
    ['fx-hue', { shift: 28, animate: true, saturation: 1.15 }],
  ]),
  combo('manga', '漫畫分鏡', 3, ['fx-split', { cols: 2, rows: 2, gap: 0.012, gapColor: '#ffffff', popIn: true }], [
    ['fx-outline', { strength: 2.4, lineColor: '#ffffff', keep: 0.55, glowLine: false }],
    ['fx-grade', { contrast: 1.35, saturation: 1.35, vignette: 0.12 }],
  ]),
];
