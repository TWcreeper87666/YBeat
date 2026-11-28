/** 簡體 → 台灣繁體（含用詞：软件 → 軟體、视频 → 影片）。字典約 1 MB，用到才載入 */
let conv: Promise<(text: string) => string> | null = null;

export function toTraditional(text: string): Promise<string> {
  conv ??= import('opencc-js/cn2t').then((m) => m.Converter({ from: 'cn', to: 'twp' }));
  conv.catch(() => { conv = null; });
  return conv.then((c) => c(text));
}
