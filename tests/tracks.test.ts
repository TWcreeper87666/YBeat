import { displayRows, tracksFromOrder, type TrackKind, type Tracks } from '../src/engine/tracks';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
type Row = { kind: TrackKind; idx: number };
const show = (rows: Row[]) => rows.map((r) => `${r.kind[0]}${r.idx}`).join(' ');
/** 用名字（height 當成 id）追蹤軌道，確認重排後顯示順序跟要求的一樣 */
const names = (t: Tracks, rows: Row[]) => rows.map((r) => t[r.kind][r.idx].height).join(',');

const base = (): Tracks => ({
  video: [{ height: 1 }, { height: 2 }],
  fx: [{ height: 3, level: 1 }, { height: 4 }],
  audio: [{ height: 5 }, { height: 6, row: 0 }],
});

for (const upperAt of ['bottom', 'top'] as const) {
  const t = base();
  const rows = displayRows(t, upperAt);
  console.log(`   [${upperAt}] 原本：${show(rows)}`);

  // 1. 原樣重建 → 順序不變
  {
    const r = tracksFromOrder(t, rows, upperAt);
    ok(names(r.tracks, displayRows(r.tracks, upperAt)) === names(t, rows), `[${upperAt}] 原順序重建後不變`);
  }

  // 2. 所有排列都能表示（4! × ... 太多，抽幾種：反轉、音訊插中間、特效放最下）
  const perms: Row[][] = [
    [...rows].reverse(),
    [rows[2], rows[0], rows[5], rows[1], rows[3], rows[4]],
    [...rows.filter((x) => x.kind !== 'fx'), ...rows.filter((x) => x.kind === 'fx')],
    [...rows.filter((x) => x.kind === 'audio'), ...rows.filter((x) => x.kind !== 'audio')],
  ];
  perms.forEach((want, i) => {
    const r = tracksFromOrder(t, want, upperAt);
    const got = displayRows(r.tracks, upperAt);
    ok(names(r.tracks, got) === names(t, want), `[${upperAt}] 排列 ${i + 1}：${show(want)} → ${names(r.tracks, got)}`);
    // 對照表要涵蓋每條軌道，且新 index 不重複
    for (const k of ['video', 'fx', 'audio'] as TrackKind[]) {
      const vals = [...r.maps[k].values()];
      ok(vals.length === t[k].length && new Set(vals).size === vals.length, `[${upperAt}] 排列 ${i + 1}：${k} 對照表完整`);
    }
  });
}

// 2b. 全部 720 種排列都能精確表示
for (const upperAt of ['bottom', 'top'] as const) {
  const t = base();
  const rows = displayRows(t, upperAt);
  const perm = (a: Row[]): Row[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perm([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  const all = perm(rows);
  const bad = all.filter((want) => {
    const r = tracksFromOrder(t, want, upperAt);
    return names(r.tracks, displayRows(r.tracks, upperAt)) !== names(t, want);
  });
  ok(all.length === 720 && bad.length === 0, `[${upperAt}] 全部 ${all.length} 種排列都正確（錯 ${bad.length} 種）`);
}

// 3. 特效軌的作用範圍：特效軌放在兩條影片軌中間 → level = 1
{
  const t: Tracks = { video: [{ height: 1 }, { height: 2 }], fx: [{ height: 3 }], audio: [] };
  // upperAt = top：由上到下 = 影片2、特效、影片1
  const r = tracksFromOrder(t, [{ kind: 'video', idx: 1 }, { kind: 'fx', idx: 0 }, { kind: 'video', idx: 0 }], 'top');
  ok(r.tracks.fx[0].level === 1, '特效軌夾在兩條影片軌中間 → 只作用在下面一條');
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
