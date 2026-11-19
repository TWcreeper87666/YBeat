/**
 * 介面語言。原文（中文）就是 key，英文對照在 i18n.en.ts。
 * 語言在載入時決定；切換語言會存檔後重新整理頁面（見 App.tsx 的 changeLanguage）。
 */
import { EN } from './i18n.en';
import { JA } from './i18n.ja';

export type Lang = 'zh' | 'en' | 'ja';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'zh', label: '繁體中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
];

const KEY = 'beatsync-lang';

function detect(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'zh' || v === 'en' || v === 'ja') return v;
  } catch {
    /* 無法存取 localStorage */
  }
  return 'zh';
}

export const lang: Lang = detect();
if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : lang;

/** 翻譯；`{0}`、`{1}` 會換成後面的參數 */
export function $t(s: string, ...args: unknown[]): string {
  let out = lang === 'en' ? EN[s] ?? s : lang === 'ja' ? JA[s] ?? EN[s] ?? s : s;
  if (args.length) out = out.replace(/\{(\d+)\}/g, (m, i) => (+i < args.length ? String(args[+i]) : m));
  return out;
}

export function saveLang(l: Lang) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* ignore */
  }
}

/**
 * 模組名稱（多半是「中文 English」）：英文介面只顯示英文部分。
 * 自訂模組的名稱照原樣顯示。
 */
export function displayName(name: string): string {
  if (lang === 'zh') return name;
  if (lang === 'ja' && JA[name]) return JA[name];
  if (EN[name]) return EN[name];
  const m = /^(.*[㐀-鿿].*?)\s+([A-Za-z][\x20-\x7e]*)$/.exec(name);
  return m ? m[2] : name;
}
