import { expandPop, keepFace, popFraming, scoreMatte, traceMatte, POP_VARIANTS, type MatteScore, type PopVariant } from '../src/engine/subjectPop';

let fails = 0;
const ok = (value: boolean, name: string) => {
  console.log(`${value ? 'PASS' : 'FAIL'}  ${name}`);
  if (!value) fails++;
};
const close = (a: number, b: number, tolerance = 0.01) => Math.abs(a - b) <= tolerance;
const size = 320;
const mask = (inside: (x: number, y: number) => boolean) => Uint8Array.from({ length: size * size }, (_, i) =>
  inside(i % size, Math.floor(i / size)) ? 255 : 0);
const paths = (path: string) => [...path.matchAll(/M([^Z]+)Z/g)].map((match) =>
  [...match[1].matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((point) =>
    [Number(point[1]), Number(point[2])] as const));
const polygonArea = (points: readonly (readonly [number, number])[]) => Math.abs(points.reduce((sum, p, i) => {
  const q = points[(i + 1) % points.length];
  return sum + p[0] * q[1] - q[0] * p[1];
}, 0)) / 2;
const tracedDisc = paths(traceMatte(mask((x, y) => (x - 160) ** 2 + (y - 160) ** 2 <= 90 ** 2), size));
ok(tracedDisc.length === 1 && Math.abs(polygonArea(tracedDisc[0]) - Math.PI * (90 * 200 / size) ** 2) /
  (Math.PI * (90 * 200 / size) ** 2) < 0.03 && tracedDisc[0].every(([x, y]) =>
  x >= 0 && x <= 200 && y >= 0 && y <= 200), '圓形追蹤面積與座標');
ok(paths(traceMatte(mask((x, y) => {
  const d = (x - 160) ** 2 + (y - 160) ** 2;
  return d <= 90 ** 2 && d >= 35 ** 2;
}), size)).length === 2, '環形保留外框與洞');
ok(paths(traceMatte(mask((x, y) => (x - 90) ** 2 + (y - 160) ** 2 <= 35 ** 2 ||
  (x - 230) ** 2 + (y - 160) ** 2 <= 35 ** 2), size)).length === 2, '兩塊主體各有輪廓');
ok(paths(traceMatte(mask((x, y) => (x - 160) ** 2 + (y - 160) ** 2 <= 60 ** 2 ||
  x >= 5 && x < 9 && y >= 5 && y < 9), size)).length === 1, '略過細小碎片');
ok(traceMatte(new Uint8Array(size * size), size) === '', '空遮罩無路徑');
const disc = scoreMatte(mask((x, y) => (x - 160) ** 2 + (y - 160) ** 2 <= 90 ** 2), size);
ok(close(disc.area, Math.PI * 90 ** 2 / size ** 2) && close(disc.cu, 0.5) && close(disc.cv, 0.5), 'disc area and centre');
ok(close(disc.bbox[0], 70 / size) && close(disc.bbox[2], 251 / size) && disc.edge === 0, 'disc bounds and edge');
const edge = scoreMatte(mask((x, y) => x < 50 && y < 50), size);
ok(edge.bbox[0] === 0 && edge.bbox[1] === 0 && edge.edge > 0.02, 'edge touching blob');
const empty = scoreMatte(new Uint8Array(size * size), size);
ok(empty.area === 0 && empty.edge === 0 && empty.bbox.every((v) => v === 0), 'empty mask');

// 只留臉連著的那一塊：人（頭 + 身體）在中間，右邊有一棵樹
{
  const head = (x: number, y: number) => (x - 120) ** 2 + (y - 90) ** 2 <= 30 ** 2;
  const body = (x: number, y: number) => x >= 80 && x < 160 && y >= 115 && y < 300;
  const tree = (x: number, y: number) => x >= 240 && x < 300 && y >= 40 && y < 300;
  const face = { x: 120 / size, y: 90 / size, w: 50 / size, h: 50 / size };
  const kept = keepFace(mask((x, y) => head(x, y) || body(x, y) || tree(x, y)), size, face);
  ok(!!kept && kept[150 * size + 120] === 255 && kept[150 * size + 270] === 0, '只留臉連著的那一塊（背景的樹拿掉）');
  ok(keepFace(mask(head), size, face) === null, '只有一顆頭（沒有身體）：不能用');
  ok(keepFace(mask(tree), size, face) === null, '臉的位置沒有主體：不能用');
  // 特寫：臉很大、肩膀一路到畫面下緣（臉下面不到一個臉高）
  const bigFace = { x: 0.5, y: 0.55, w: 0.35, h: 0.4 };
  const closeUp = (x: number, y: number) => ((x - 160) ** 2 / 60 ** 2 + (y - 176) ** 2 / 70 ** 2 <= 1) || (y >= 230 && x >= 40 && x < 280);
  ok(!!keepFace(mask(closeUp), size, bigFace), '特寫的上半身（連到畫面下緣）：可以');
  // 整個人站在畫面中間：身體沒碰到下緣，但往下延伸夠多
  const standing = (x: number, y: number) => head(x, y) || (x >= 95 && x < 145 && y >= 115 && y < 200);
  ok(!!keepFace(mask(standing), size, face), '身體沒碰到下緣、往下延伸夠多：可以');
}

const frame = (s: MatteScore, mw = 1920, mh = 1080) => popFraming(s, mw, mh, 1920, 1080);
ok(frame(disc).ok && frame(disc).centered, 'centred disc framing');
const top = { ...disc, cu: 0.5, cv: 0.15, bbox: [0.25, 0.05, 0.75, 0.25] as MatteScore['bbox'] };
ok(!frame(top, 1080, 1920).ok, 'portrait cover crops top subject');
ok(!frame({ ...disc, area: 0.01 }).ok && !frame({ ...disc, area: 0.8 }).ok, 'tiny and huge subjects');
// 人像：頭在上面、身體一路到下緣
const bust = scoreMatte(mask((x, y) => (x - 160) ** 2 + (y - 120) ** 2 <= 50 ** 2 || (y >= 160 && x >= 90 && x < 230)), size);
ok(!frame(bust).ok && frame(bust).loose, '碰到下緣：不能一般跳出，可以做剪影窗 / 主體挖洞');
const sideCut = scoreMatte(mask((x, y) => x < 120 && y >= 60 && y < 260), size);
ok(!frame(sideCut).ok && frame(sideCut).loose, '碰到左右邊緣：只做剪影窗 / 主體挖洞');
ok(frame({ ...disc, area: 0.6 }, 1920, 1080).loose && popFraming({ ...disc, area: 0.6 }, 1920, 1080, 1080, 1920).loose,
  '橫式素材放進直式畫面：主體看起來很大也可以');
const farLeft = scoreMatte(mask((x) => x < 30), size);
ok(!frame(farLeft).loose && !frame({ ...disc, area: 0.01 }).loose && !frame({ ...disc, area: 0.8 }).loose, '在畫面外、太小、太大：都不行');

const T = (b: number) => b * 0.5;
const base = { b0: 60, b1: 64, mediaId: 'image', cx: 0.2, cy: -0.1 };
const step = expandPop({ ...base, variant: 'step' }, T);
ok(step.length === 1 && step[0].matte && step[0].layer === 1 && step[0].t1 === T(64), 'step layer and end');
ok(step[0].keys?.scaleX?.length === 5 && step[0].keys.scaleX.at(-1)?.v === 1 &&
  step[0].keys.scaleX.every((k) => k.ease === 'hold'), 'step hold scales');
const masked = expandPop({ ...base, variant: 'step', path: 'M0 0L10 0L10 10Z' }, T)[0];
ok(masked.matte && masked.mask?.path === 'M0 0L10 0L10 10Z' && !masked.mask.invert &&
  masked.mask.scale.map((k) => k.v).join() === masked.keys?.scaleX?.map((k) => k.v).join() && masked.keys?.scaleX?.at(-1)?.v === 1,
  '有主體輪廓：逐拍放大用遮罩只留這個人，遮罩跟著主體縮放，最後回到原尺寸');
ok(!step[0].mask, '沒有輪廓：只用 AI 去背');
const outline = 'M0 0L10 0L10 10Z';
ok(expandPop({ ...base, b0: 62, variant: 'fly', path: outline }, T).every((l) => !l.mask), '飛入（位置在動）：不加輪廓遮罩');
ok(expandPop({ ...base, variant: 'mono', path: outline }, T).some((l) => l.matte && l.mask?.path === outline), '黑白背景：去背層加輪廓遮罩');
ok(close(step[0].keys?.x?.[0].v ?? 0, 0.09) && close(step[0].keys?.y?.[0].v ?? 0, -0.045) &&
  step[0].keys?.x?.at(-1)?.v === 0, 'step centre compensation');
const shake = expandPop({ ...base, variant: 'shake' }, T);
ok(shake[0].effects?.map((e) => e.moduleId).join(',') === 'fx-shake,fx-flash' &&
  shake[0].effects.every((e) => e.beatEvery === 1 && e.hitSec === 0.18), 'shake beat effects');
const mono = expandPop({ ...base, variant: 'mono' }, T);
ok(mono.length === 2 && !mono[0].matte && mono[1].matte && mono[0].effects?.[0].moduleId === 'fx-bw' &&
  mono.every((layer) => layer.t1 === T(64)), 'mono full and colour cutout');
const fly = expandPop({ ...base, b0: 62, variant: 'fly' }, T)[0];
ok(close(fly.keys?.x?.[0].v ?? 0, -1.1) && fly.keys?.x?.[1].v === 0 && fly.keys?.x?.at(-1)?.v === 0 && !fly.keys?.y &&
  fly.keys?.rotation?.[1].v === 0 && fly.t1 === T(64), '飛入：從畫面外飛到原位（位移 0 = 跟完整圖對齊）');

const newVariants = ['crossShot', 'textBehind', 'trail', 'grid', 'spin', 'dim', 'halo', 'blur'] as const satisfies readonly PopVariant[];
ok(POP_VARIANTS.slice(4).join(',') === [...newVariants, 'silhouetteWindow', 'subjectHole'].join(','), '新增種類順序固定');
for (const variant of newVariants) {
  const layers = expandPop({ ...base, variant, revealMediaId: 'other', text: '標題' }, T);
  const count = { crossShot: 2, textBehind: 3, trail: 3, grid: 5, spin: 3, dim: 2, halo: 1, blur: 2 }[variant];
  ok(layers.length === count && layers.every((layer) => layer.t1 === T(64)), `${variant} 層數及終點`);
  const aligned = layers.filter((layer) => layer.matte && layer.keys?.scaleX?.at(-1)?.v === 1 &&
    layer.keys.x?.at(-1)?.v === 0 && layer.keys.y?.at(-1)?.v === 0 &&
    layer.keys.rotation?.at(-1)?.v === 0 && layer.keys.opacity?.at(-1)?.v === 1).at(-1);
  ok(!!aligned, `${variant} 最後主體對齊`);
  ok(layers.every((layer) => (layer.text !== undefined) === (variant === 'textBehind' && layer.layer === 2)),
    `${variant} 文字層位置`);
  for (const layer of layers.filter((item) => item.matte && item.keys?.scaleX && item.keys.x && item.keys.y &&
    !['grid', 'spin'].includes(variant))) {
    ok(layer.keys!.scaleX!.every((k, i) => close(layer.keys!.x![i].v, base.cx * (1 - k.v)) &&
      close(layer.keys!.y![i].v, base.cy * (1 - k.v))), `${variant} 第 ${layer.layer} 層中心補償`);
  }
}
const cross = expandPop({ ...base, variant: 'crossShot', revealMediaId: 'other' }, T);
ok(cross[0].mediaId === 'other' && !cross[0].matte && cross[1].keys?.opacity?.[0].v === 0 &&
  cross[1].keys.opacity[1].t === 0.25, 'crossShot 背景及半拍淡入');
const textBehind = expandPop({ ...base, variant: 'textBehind', text: '標題' }, T);
ok(textBehind[1].text === '標題' && textBehind[1].keys?.opacity?.[1].t === 0.5 &&
  !textBehind[0].matte && textBehind[2].matte, 'textBehind 文字在主體後方');
const trail = expandPop({ ...base, variant: 'trail' }, T);
ok(trail.every((layer, i) => layer.t0 === T(61 + i)) && trail.slice(0, 2).every((layer) =>
  layer.blend === 'screen' && layer.keys?.opacity?.at(-1)?.v === 0) && trail[2].keys?.opacity?.at(-1)?.v === 1,
  'trail 逐拍殘影及混合');
const grid = expandPop({ ...base, variant: 'grid' }, T);
ok(grid.slice(0, 4).every((layer, i) => layer.keys?.opacity?.at(-1)?.v === 0 &&
  close(0.45 * base.cx + (layer.keys?.x?.[0].v ?? 0), i % 2 ? 0.25 : -0.25)) &&
  grid[4].t0 === T(63), 'grid：主體落在四個角、淡出，中央揭露');
const spin = expandPop({ ...base, variant: 'spin' }, T);
ok(spin.slice(0, 2).every((layer) => layer.keys?.opacity?.at(-1)?.v === 0) &&
  spin[2].keys?.rotation?.[0].v === 0, 'spin 側影淡出');
const dim = expandPop({ ...base, variant: 'dim' }, T);
ok(dim[0].effects?.[0].moduleId === 'fx-grade' && dim[0].effects[0].params.saturation === 0.25 &&
  dim[0].effects[0].params.vignette === 0.9, 'dim 調色參數');
const halo = expandPop({ ...base, variant: 'halo' }, T);
ok(halo[0].effects?.[0].moduleId === 'fx-matteoutline' && halo[0].effects[0].params.width === 14 &&
  halo[0].effects[0].params.pulse === true && halo[0].effects[0].beatEvery === 1 &&
  close(halo[0].effects[0].hitSec ?? 0, 0.4), 'halo 描邊逐拍觸發');
const blur = expandPop({ ...base, variant: 'blur' }, T);
ok(blur[0].effects?.[0].moduleId === 'fx-blur' && blur[0].effects[0].params.amount === 14 &&
  !blur[1].effects, 'blur 背景持續模糊');

for (const variant of ['silhouetteWindow', 'subjectHole'] as const) {
  const layers = expandPop({ ...base, variant, revealMediaId: 'B', path: 'M10 10L90 10L90 90Z' }, T);
  const expected = variant === 'silhouetteWindow' ? [1, 1.1, 1.2, 1.35, 1.35] : [1, 1.15, 1.35, 1.6, 1.6];
  ok(layers.length === 2 && layers[0].mediaId === (variant === 'silhouetteWindow' ? 'image' : 'B') &&
    layers[1].mediaId === (variant === 'silhouetteWindow' ? 'B' : 'image') &&
    layers.every((layer) => !layer.matte && layer.t0 === T(60) && layer.t1 === T(64) && !layer.keys) &&
    !layers[0].mask && layers[1].mask?.path === 'M10 10L90 10L90 90Z' &&
    layers[1].mask.invert === (variant === 'subjectHole') &&
    layers[1].mask.scale.every((k, i) => k.v === expected[i] && k.t === T(60 + i) - T(60) && k.ease === 'hold'),
  `${variant} 使用第二層路徑遮罩與逐拍放大`);
}

console.log(fails ? `\n${fails} failed` : '\nAll passed');
if (fails) process.exit(1);
