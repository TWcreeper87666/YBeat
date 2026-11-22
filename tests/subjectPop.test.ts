import { expandPop, popFraming, scoreMatte, type MatteScore } from '../src/engine/subjectPop';

let fails = 0;
const ok = (value: boolean, name: string) => {
  console.log(`${value ? 'PASS' : 'FAIL'}  ${name}`);
  if (!value) fails++;
};
const close = (a: number, b: number, tolerance = 0.01) => Math.abs(a - b) <= tolerance;
const size = 320;
const mask = (inside: (x: number, y: number) => boolean) => Uint8Array.from({ length: size * size }, (_, i) =>
  inside(i % size, Math.floor(i / size)) ? 255 : 0);
const disc = scoreMatte(mask((x, y) => (x - 160) ** 2 + (y - 160) ** 2 <= 90 ** 2), size);
ok(close(disc.area, Math.PI * 90 ** 2 / size ** 2) && close(disc.cu, 0.5) && close(disc.cv, 0.5), 'disc area and centre');
ok(close(disc.bbox[0], 70 / size) && close(disc.bbox[2], 251 / size) && disc.edge === 0, 'disc bounds and edge');
const edge = scoreMatte(mask((x, y) => x < 50 && y < 50), size);
ok(edge.bbox[0] === 0 && edge.bbox[1] === 0 && edge.edge > 0.02, 'edge touching blob');
const empty = scoreMatte(new Uint8Array(size * size), size);
ok(empty.area === 0 && empty.edge === 0 && empty.bbox.every((v) => v === 0), 'empty mask');

const frame = (s: MatteScore, mw = 1920, mh = 1080) => popFraming(s, mw, mh, 1920, 1080);
ok(frame(disc).ok && frame(disc).centered, 'centred disc framing');
const top = { ...disc, cu: 0.5, cv: 0.15, bbox: [0.25, 0.05, 0.75, 0.25] as MatteScore['bbox'] };
ok(!frame(top, 1080, 1920).ok, 'portrait cover crops top subject');
ok(!frame({ ...disc, area: 0.01 }).ok && !frame({ ...disc, area: 0.8 }).ok, 'tiny and huge subjects');

const T = (b: number) => b * 0.5;
const base = { b0: 60, b1: 64, mediaId: 'image', cx: 0.2, cy: -0.1 };
const step = expandPop({ ...base, variant: 'step' }, T);
ok(step.length === 1 && step[0].matte && step[0].layer === 1 && step[0].t1 === T(64), 'step layer and end');
ok(step[0].keys?.scaleX?.length === 5 && step[0].keys.scaleX.at(-1)?.v === 1 &&
  step[0].keys.scaleX.every((k) => k.ease === 'hold'), 'step hold scales');
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

console.log(fails ? `\n${fails} failed` : '\nAll passed');
if (fails) process.exit(1);
