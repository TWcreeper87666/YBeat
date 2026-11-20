/** 逐行比較（LCS），給「AI 修改」顯示差異用 */
export type DiffLine = { op: ' ' | '+' | '-'; text: string };

export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  // 模組都很短；太長就退回整段替換，避免 O(n·m) 吃太多記憶體
  if (n * m > 4_000_000) return [...A.map((t) => ({ op: '-' as const, text: t })), ...B.map((t) => ({ op: '+' as const, text: t }))];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: ' ', text: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', text: A[i++] });
    else out.push({ op: '+', text: B[j++] });
  }
  while (i < n) out.push({ op: '-', text: A[i++] });
  while (j < m) out.push({ op: '+', text: B[j++] });
  return out;
}

/** 只留有變動的地方前後幾行，其他折疊成 null（顯示「…」） */
export function hunks(d: DiffLine[], ctx = 2): (DiffLine | null)[] {
  const keep = new Array(d.length).fill(false);
  d.forEach((l, k) => {
    if (l.op !== ' ') for (let x = Math.max(0, k - ctx); x <= Math.min(d.length - 1, k + ctx); x++) keep[x] = true;
  });
  const out: (DiffLine | null)[] = [];
  d.forEach((l, k) => {
    if (keep[k]) out.push(l);
    else if (out[out.length - 1] !== null) out.push(null);
  });
  return out;
}
