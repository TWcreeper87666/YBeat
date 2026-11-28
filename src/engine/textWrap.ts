/**
 * 文字限寬自動換行：
 * - 中文用 Intl.Segmenter 切詞，盡量不從詞中間斷；標點後面最適合斷，行首不放標點（避頭）
 * - 英文只在空白處斷（單字比整行還寬才硬切）
 * - 行數用最少的，再讓每一行差不多長（不會變成「很長一行 + 最後剩兩個字」）
 */

/** 不能放在行首的標點 */
const NO_START = /^[，。、！？；：」』）》〉】〕…—,.!?;:)\]}%]/;
/** 句子 / 子句結束的標點：在後面斷最自然 */
const CLAUSE_END = /[，。、！？；：」』）》…,.!?;:)]\s*$/;

interface Piece { text: string; cost: number }

let segmenter: Intl.Segmenter | null | undefined;
function words(text: string): string[] {
  if (segmenter === undefined) {
    try { segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('zh', { granularity: 'word' }) : null; } catch { segmenter = null; }
  }
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  // 沒有 Segmenter：中文一個字一段，其他依空白
  return text.match(/[㐀-鿿豈-﫿]|[^㐀-鿿豈-﫿]+?(?=[㐀-鿿豈-﫿]|\s|$)\s*|\s+/g) ?? [text];
}

/** 把一行切成可以在後面斷行的小段；cost = 在這段後面斷的代價 */
function pieces(line: string): Piece[] {
  const out: Piece[] = [];
  for (const w of words(line)) {
    const prev = out[out.length - 1];
    // 標點、空白黏到前一段（避頭；空白留在行尾，畫的時候去掉）
    if (prev && (NO_START.test(w) || /^\s+$/.test(w))) { prev.text += w; continue; }
    // 英文 / 數字連著的部分不能斷（Segmenter 可能把 "3.5" 或 "don't" 切開）
    if (prev && /[A-Za-z0-9'’]$/.test(prev.text) && /^[A-Za-z0-9'’]/.test(w)) { prev.text += w; continue; }
    out.push({ text: w, cost: 0 });
  }
  for (const p of out) {
    p.cost = CLAUSE_END.test(p.text) ? 0 : /\s$/.test(p.text) ? 0.2 : 1;
  }
  return out;
}

/** 比 maxW 還寬的一段（很長的英文單字、網址）硬切成好幾段 */
function splitWide(p: Piece, maxW: number, measure: (s: string) => number): Piece[] {
  if (measure(p.text.trimEnd()) <= maxW) return [p];
  const out: Piece[] = [];
  let cur = '';
  for (const ch of p.text) {
    if (cur && measure(cur + ch) > maxW) { out.push({ text: cur, cost: 3 }); cur = ''; }
    cur += ch;
  }
  out.push({ text: cur, cost: p.cost });
  return out;
}

/**
 * 換行後的每一行。maxW = 最寬可以多寬（跟 measure 同單位）；原本的換行（\n）保留。
 */
export function wrapText(text: string, maxW: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line || measure(line) <= maxW) { out.push(line); continue; }
    const ps = pieces(line).flatMap((p) => splitWide(p, maxW, measure));
    const n = ps.length;
    // width(i, j) = 第 i..j-1 段排成一行的寬度（行尾空白不算）
    const memo = new Map<number, number>();
    const width = (i: number, j: number) => {
      const k = i * (n + 1) + j;
      let w = memo.get(k);
      if (w === undefined) { w = measure(ps.slice(i, j).map((p) => p.text).join('').trimEnd()); memo.set(k, w); }
      return w;
    };
    // 先找最少要幾行（貪婪排滿）
    let lines = 0;
    for (let i = 0; i < n; lines++) {
      let j = i + 1;
      while (j < n && width(i, j + 1) <= maxW) j++;
      i = j;
    }
    // 固定行數，挑斷點讓每行接近平均寬度、斷在好的地方
    const target = width(0, n) / lines;
    // best[k][j] = 前 j 段排成 k 行的最小代價
    const best: number[][] = Array.from({ length: lines + 1 }, () => new Array(n + 1).fill(Infinity));
    const from: number[][] = Array.from({ length: lines + 1 }, () => new Array(n + 1).fill(-1));
    best[0][0] = 0;
    for (let k = 1; k <= lines; k++) {
      for (let j = 1; j <= n; j++) {
        for (let i = j - 1; i >= k - 1; i--) {
          const w = width(i, j);
          if (w > maxW) break;
          if (best[k - 1][i] === Infinity) continue;
          const dev = (w - target) / target;
          // 最後一行比平均短一點沒關係，比較不要比平均長
          const shape = k === lines && w < target ? dev * dev * 0.3 : dev * dev;
          const brk = j < n ? ps[j - 1].cost * 0.15 : 0;
          const c = best[k - 1][i] + shape + brk;
          if (c < best[k][j]) { best[k][j] = c; from[k][j] = i; }
        }
      }
    }
    if (best[lines][n] === Infinity) {
      // 理論上不會發生（貪婪排法本身就是一組解）；保險起見退回貪婪
      let i = 0;
      while (i < n) { let j = i + 1; while (j < n && width(i, j + 1) <= maxW) j++; out.push(ps.slice(i, j).map((p) => p.text).join('').trimEnd()); i = j; }
      continue;
    }
    const cuts: number[] = [];
    for (let k = lines, j = n; k > 0; j = from[k][j], k--) cuts.unshift(j);
    let i = 0;
    for (const j of cuts) { out.push(ps.slice(i, j).map((p) => p.text).join('').trimEnd()); i = j; }
  }
  return out;
}
