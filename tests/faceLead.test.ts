import { confidentLead, cosine, findLead, followableLead, guessLead, isLead, leadInfo, leadShare, pickedLead, refineLead, similarity, SFACE_DST, type FacesAt } from '../src/engine/faceLead';
import type { MediaInfo } from '../src/engine/mediaAnalysis';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// 相似變換：把樣板縮小、旋轉、平移後的點對回樣板
{
  const ang = 0.3, k = 0.5, tx = 20, ty = -7;
  const src = SFACE_DST.map(([x, y]) => [k * (Math.cos(ang) * x - Math.sin(ang) * y) + tx, k * (Math.sin(ang) * x + Math.cos(ang) * y) + ty] as [number, number]);
  const [a, b, c, d, e, f] = similarity(src, SFACE_DST);
  const back = src.map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  ok(back.every(([x, y], i) => near(x, SFACE_DST[i][0], 1e-6) && near(y, SFACE_DST[i][1], 1e-6)), '相似變換：對回樣板');
}

// 特徵：三個人，A 出現最多
// 固定亂數：seed = 哪個人，noise = 同一人每次的差異
const rand = (s: number) => () => {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
};
let noiseSeed = 99;
const vec = (seed: number, noise = 0) => {
  const r = rand(seed), n = rand(noiseSeed++);
  return Array.from({ length: 128 }, () => r() + noise * n());
};
const A = (n: number) => ({ h: 0.2, emb: vec(1, n) });
const B = (n: number) => ({ h: 0.3, emb: vec(2, n) });
const C = (n: number) => ({ h: 0.1, emb: vec(3, n) });
ok(cosine(vec(1), vec(1, 0.1)) > 0.9 && Math.abs(cosine(vec(1), vec(2))) < 0.3, '特徵：同一人像、不同人不像');
{
  const faces = [A(0), A(0.05), A(0.1), A(0.08), B(0), B(0.05), C(0)];
  const lead = findLead(faces)!;
  ok(lead.count === 4 && lead.second === 2 && near(lead.share, 4 / 7), `主角是出現最多的人（${lead.count}/${lead.second}）`);
  ok(cosine(lead.centroid, vec(1)) > 0.9, '主角特徵接近 A');
  ok(confidentLead(lead, 0.6), '主角夠明顯');
  ok(!confidentLead(lead, 0.2), '有臉的畫面裡很少有主角 → 不確定');
  ok(!confidentLead(findLead([A(0), A(0.1), B(0), B(0.1)]), 1), '兩個人一樣多 → 不確定');
  // 只比別人多一點：不夠明顯，但可以拿來決定追誰
  const slight = findLead([A(0), A(0.1), A(0.2), B(0), B(0.1)]);
  ok(!confidentLead(slight, 1) && followableLead(slight), '比別人多一點 → 不確定，但可以追');
  ok(!followableLead(findLead([A(0), A(0.1), A(0.2), B(0), B(0.1), B(0.2)])), '兩個人一樣多 → 不追');
  ok(!followableLead(findLead([A(0), A(0.1)])), '臉太少 → 不追');
  // 指定的主角：拿那張臉的特徵比對
  const picked = pickedLead(vec(2));
  ok(confidentLead(picked, 0.5) && isLead(B(0), picked) && !isLead(A(0), picked), '指定的主角只認那個人');
  // 指定的那一格比較糊：用其他素材裡很像的臉擴充，會更接近這個人本來的樣子，也不會收到別人
  const blurry = vec(2, 0.6);
  const pool = [B(0.2), B(0.25), B(0.3), B(0.2), A(0), A(0.1), C(0)];
  const refined = refineLead(blurry, pool);
  ok(cosine(refined, vec(2)) > cosine(blurry, vec(2)) && cosine(refined, vec(1)) < 0.3 && cosine(refined, vec(3)) < 0.3,
    `擴充指定主角：更像本人（${cosine(blurry, vec(2)).toFixed(2)} → ${cosine(refined, vec(2)).toFixed(2)}），不收別人`);
  ok(cosine(refineLead(vec(2), [A(0), C(0)]), vec(2)) > 0.999, '沒有像的臉：用原本那張');
  // 群眾畫面：一格很多張別人的臉，用格數算主角還是佔多數
  const crowd: FacesAt[] = [
    [{ x: 0.5, y: 0.5, w: 0.1, h: 0.2, ...A(0) }, ...Array.from({ length: 6 }, (_, k) => ({ x: 0.1 * k, y: 0.8, w: 0.03, h: 0.05, emb: vec(10 + k) }))],
    [{ x: 0.5, y: 0.5, w: 0.1, h: 0.2, ...A(0.05) }],
    [{ x: 0.5, y: 0.5, w: 0.1, h: 0.2, ...B(0) }],
  ];
  ok(near(leadShare(crowd, lead), 2 / 3), '主角佔有臉畫面的格數比例');
  ok(findLead([]) === null, '沒有臉 → null');
}

// 每個取樣點：只有別人 → 避開；主角的臉拿來推近；沒取樣的點用最近的
{
  const lead = findLead([A(0), A(0.05), A(0.1)])!;
  const info: MediaInfo = { step: 1, duration: 10, motion: Array(10).fill(0.5), quality: Array(10).fill(1), cuts: [] };
  const at = (list: ReturnType<typeof A>[], x = 0.3): FacesAt => list.map((f) => ({ x, y: 0.4, w: 0.1, h: f.h, emb: f.emb }));
  const facesAt: FacesAt[] = Array(10).fill(null);
  facesAt[0] = at([A(0)]);
  facesAt[2] = at([B(0)]);
  facesAt[4] = at([B(0), A(0.05)], 0.7);
  facesAt[6] = [{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]; // 太小、沒有特徵
  facesAt[8] = at([C(0)]);
  const r = leadInfo(info, facesAt, lead);
  ok(JSON.stringify(r.states.filter(Boolean)) === '["lead","others","lead","none","others"]', `取樣點狀態（${JSON.stringify(r.states.filter(Boolean))}）`);
  ok(JSON.stringify(r.ban) === '[[1,3],[7,10]]', `只有別人的範圍（${JSON.stringify(r.ban)}）`);
  ok(r.faces[4]?.x === 0.7 && r.faces[0]?.x === 0.3 && r.faces[2] === null, '主角的臉（同框時挑主角，不是最大的）');
  ok(r.faces[5]?.x === 0.7 && r.people[5] > 0 && r.people[2] === 0, '沒取樣的點用最近的');
}

// 認不出主角時：同框最像主角、而且明顯比別人像的那張臉；差不多像 / 都不像 = 不猜
{
  const lead = pickedLead([1, 0, 0]);
  const me = { x: 0.3, y: 0.4, h: 0.2, emb: [0.25, 0.97, 0] };   // cos ≈ 0.25（側臉，沒到 IS_LEAD）
  const other = { x: 0.8, y: 0.4, h: 0.25, emb: [0.02, 0, 1] };
  ok(guessLead([other, me], lead) === me, '認不出主角：挑同框最像的');
  ok(guessLead([me, { ...other, emb: [0.2, 0.98, 0] }], lead) === null, '兩個差不多像：不猜');
  ok(guessLead([other], lead) === null, '都不像：不猜');
  ok(guessLead([{ ...me, emb: undefined }], lead) === null, '沒有特徵：不猜');
}

if (fails) {
  console.log(`\n${fails} 個失敗`);
  process.exit(1);
}

