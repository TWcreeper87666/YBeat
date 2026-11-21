/** 把 key 移到 index（index = 插入點：移動前，第幾個項目的前面；等於長度 = 最後）。沒變就回傳原陣列 */
export function moveKey(keys: string[], key: string, index: number): string[] {
  const from = keys.indexOf(key);
  if (from < 0) return keys;
  const to = Math.max(0, Math.min(keys.length - 1, index > from ? index - 1 : index));
  if (to === from) return keys;
  const next = keys.filter((k) => k !== key);
  next.splice(to, 0, key);
  return next;
}

/** 只調整 subset（例如我的最愛）在完整清單裡的順序：其他項目位置不變 */
export function reorderSubset(all: string[], subsetOrder: string[]): string[] {
  const set = new Set(subsetOrder);
  let i = 0;
  return all.map((k) => (set.has(k) ? subsetOrder[i++] : k));
}
