import { FLAT_SHAPE, isFlat, offsetAt, shapeMusic } from '../src/engine/energyShape';
import type { MusicInfo } from '../src/engine/musicAnalysis';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

const info: MusicInfo = {
  energy: Array.from({ length: 100 }, (_, i) => (i < 50 ? 0.3 : 0.6)),
  level: Array.from({ length: 100 }, (_, i) => (i < 50 ? 0 : 1)),
  sections: [{ b0: 0, b1: 50, energy: 0.3, kind: 'intro' }, { b0: 50, b1: 100, energy: 0.6, kind: 'body' }],
  drops: [50], accents: [10, 60],
};

ok(shapeMusic(info, FLAT_SHAPE()) === info && isFlat(FLAT_SHAPE()), '平的曲線 = 原樣');
ok(offsetAt([{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 0 }], 0.25) === 0.5, '控制點之間線性內插');

const up = shapeMusic(info, { ...FLAT_SHAPE(), gain: 0.2 });
ok(up.level.slice(50).every((l) => l === 2) && up.level.slice(0, 50).every((l) => l === 1), '整體強度往上 → 每一段升一級');

const peak = shapeMusic(info, { gain: 0, contrast: 1, points: [{ x: 0, y: 0 }, { x: 0.7, y: 0 }, { x: 0.8, y: 1 }, { x: 0.9, y: 0 }, { x: 1, y: 0 }] });
ok(peak.level[80] === 2 && peak.level[60] === 1 && peak.level[95] === 1, '控制點只拉高那一段');
ok(peak.sections[1].energy > info.sections[1].energy && Math.abs(peak.sections[0].energy - info.sections[0].energy) < 1e-9, '段落能量跟著重算');
ok(peak.drops === info.drops && peak.accents === info.accents && peak.sections[1].kind === 'body', 'drop、重音、段落種類不變');

const wide = shapeMusic(info, { ...FLAT_SHAPE(), contrast: 2 });
ok(wide.energy[0] < 0.3 && wide.energy[0] >= 0 && wide.energy[99] === 0.6, '對比以 0.6 為中心拉開');
ok(shapeMusic(info, { ...FLAT_SHAPE(), gain: 0.5, contrast: 2 }).energy.every((e) => e <= 1), '夾在 0..1');

if (fails) {
  console.log(`\n${fails} 個失敗`);
  process.exit(1);
}
