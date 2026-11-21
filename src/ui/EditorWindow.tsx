import { $t, displayName } from '../i18n';
import { useEffect, useRef } from 'react';
import { Columns2, Rows2, Sparkles, X } from 'lucide-react';
import { parseTrSel, useStore } from '../store';
import { sortClips, transitionWindow } from '../engine/renderer';
import { itemName } from './names';
import { Slot } from './PreviewPanel';
import { useMaskEdit } from './MaskEditor';
import { confirmDialog, useEditorMode, useEditorWindow, useLayout } from './uiStore';
import { docChanged, restoreDoc, snapshotDoc, type HistoryDoc } from '../engine/history';
import type { PanelId } from './dockTree';
import { isTextField, modalOpen } from './focus';
import { pickerOpen } from './Library';

/**
 * 編輯視窗（參考威力導演的子母畫面設計師）：針對「一個片段 / 特效 / 轉場」的編輯畫面。
 * - 屬性 + 預覽放在置中、不能移動的對話框裡（把兩個面板的 DOM 搬進來，關閉時搬回原本的分頁）。
 * - 預覽只看這個項目：進度條 / 時間以項目為範圍，播放在項目內循環。
 * - 橫式輸出時預覽在上、屬性在下（關鍵影格時間軸可以很寬）；直式輸出時屬性在左、預覽在右。
 */
export { useEditorWindow };

/** 分隔線粗細（px，跟停駐區一樣） */
const SASH = 4;
/** 兩個區塊的最小尺寸（px）：屬性要放得下左欄 240px + 一點關鍵影格時間軸；預覽至少看得到畫面 */
const MIN = { side: { first: 360, second: 200 }, stacked: { first: 160, second: 180 } };

/** 打開編輯視窗；maskKey：同時進入某個遮罩的「在預覽中編輯」 */
export function openEditorWindow(maskKey?: string) {
  if (maskKey) useMaskEdit.setState({ key: maskKey });
  if (useEditorWindow.getState().open) return;
  const s = useStore.getState();
  const r = scopeOf(s);
  if (!r) return;
  saved = { loop: s.loop, doc: snapshotDoc() };
  // 播放頭不在項目裡 → 移到項目開頭；播放範圍限制在項目內
  useStore.setState({ loop: r, ...(s.time < r.a || s.time >= r.b ? { time: r.a } : {}) });
  useEditorWindow.setState({ open: true });
}

export function closeEditorWindow() {
  if (!useEditorWindow.getState().open) return;
  useEditorWindow.setState({ open: false });
  useStore.setState({ loop: saved?.loop ?? null });
  saved = null;
}

/** 開編輯視窗前的循環設定（關閉時還原）與專案狀態（取消時還原） */
let saved: { loop: { a: number; b: number } | null; doc: HistoryDoc } | null = null;

/** 取消（✕ / Esc）：有變更時先確認，捨棄後還原成打開時的狀態（還原算一步，可以 Ctrl+Z 拿回來） */
export async function cancelEditorWindow() {
  if (!useEditorWindow.getState().open || !saved) return;
  if (docChanged(saved.doc)) {
    const ok = await confirmDialog({ title: $t('捨棄變更？'), message: $t('編輯視窗裡的變更還沒套用。'), ok: $t('捨棄'), danger: true });
    if (!ok || !saved) return;
    restoreDoc(saved.doc);
  }
  closeEditorWindow();
}

type ScopeState = Pick<ReturnType<typeof useStore.getState>, 'selection' | 'clips' | 'effects'>;
/** 編輯視窗針對的項目時間範圍（影片 / 文字片段、特效軌的特效、轉場） */
function scopeOf(s: ScopeState): { a: number; b: number } | null {
  const sel = s.selection;
  if (sel?.type === 'transition') {
    const { clipId, side } = parseTrSel(sel.id);
    const c = s.clips.find((x) => x.id === clipId);
    if (!c) return null;
    const sorted = sortClips(s.clips.filter((x) => x.track === c.track));
    const i = sorted.findIndex((x) => x.id === c.id);
    const w = transitionWindow(sorted[i - 1], c, side, sorted[i + 1]);
    return w ? { a: w.t0, b: w.t0 + w.d } : null;
  }
  if (sel?.type !== 'clip' && sel?.type !== 'effect') return null;
  const it = (sel.type === 'clip' ? s.clips : s.effects).find((x) => x.id === sel.id);
  return it ? { a: it.start, b: it.start + it.duration } : null;
}

/** 預覽的播放列用：編輯視窗開著時回傳項目的範圍，否則 null（整個專案） */
export function useEditorScope(): { a: number; b: number } | null {
  const open = useEditorWindow((s) => s.open);
  const a = useStore((s) => scopeOf(s)?.a);
  const b = useStore((s) => scopeOf(s)?.b);
  return open && a !== undefined && b !== undefined ? { a, b } : null;
}

// 視窗開著時：項目被修剪 / 移動 → 播放範圍跟著改；選取被清掉（例如刪掉了）→ 自動關閉
useStore.subscribe((s, p) => {
  if (!useEditorWindow.getState().open) return;
  if (p.selection && !s.selection) return closeEditorWindow();
  const r = scopeOf(s);
  if (r && (!s.loop || Math.abs(s.loop.a - r.a) > 1e-9 || Math.abs(s.loop.b - r.b) > 1e-9)) {
    useStore.setState({ loop: r, ...(s.time < r.a || s.time >= r.b ? { time: r.a } : {}) });
  }
});

export function EditorWindow({ hosts }: { hosts: Record<PanelId, HTMLElement> }) {
  const open = useEditorWindow((s) => s.open);
  const sel = useStore((s) => s.selection);
  const name = useStore((s) => {
    if (sel?.type === 'transition') {
      const { clipId, side } = parseTrSel(sel.id);
      const c = s.clips.find((x) => x.id === clipId);
      const tr = side === 'out' ? c?.transitionOut : c?.transitionIn;
      const m = tr && s.modules.find((x) => x.id === tr.moduleId);
      return m ? displayName(m.name) : '';
    }
    if (!sel || (sel.type !== 'clip' && sel.type !== 'effect')) return '';
    const it = (sel.type === 'clip' ? s.clips : s.effects).find((x) => x.id === sel.id);
    return it ? itemName(sel.type, it, s.media, s.modules) : '';
  });
  const pref = useLayout((s) => s.editorLayout);
  const split = useLayout((s) => s.editorSplit);
  const leftPx = useLayout((s) => s.ecLeftPx);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 自動排版看輸出尺寸：橫式（16:9 等）預覽本來就扁 → 放上面、屬性在下（關鍵影格時間軸變寬）；
  // 直式（9:16 等）預覽很瘦高 → 放右邊用滿高度、屬性在左
  const landscape = useStore((s) => s.format.w >= s.format.h);
  const mode = useEditorMode(landscape) ?? 'side';

  useEffect(() => {
    if (!open) return;
    // Esc 取消、Ctrl+Enter 完成（capture：比全域快捷鍵先處理，免得 Esc 清掉選取）
    const key = (e: KeyboardEvent) => {
      if (pickerOpen() || modalOpen() || (e.target as HTMLElement | null)?.closest?.('.text-inline')) return;
      // Ctrl+Enter = 完成（在輸入框裡也可以）
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.stopPropagation();
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.(); // 正在輸入的數值先套用
        return closeEditorWindow();
      }
      if (e.key !== 'Escape' || isTextField(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      void cancelEditorWindow();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);

  if (!open) return null;
  const ratio = split[mode];
  // 上下排：預覽在上（佔 ratio）、屬性在下；左右排：屬性在左（佔 ratio）、預覽在右。
  // 直接用比例算第一格的大小（不用 fr + 最小值，那樣實際位置跟比例對不上，拖的時候會跳）
  // 左右排：屬性區塊至少要放得下左欄 + 120px 的關鍵影格時間軸
  const m = mode === 'side' ? { ...MIN.side, first: Math.max(MIN.side.first, Math.max(240, leftPx) + 120) } : MIN[mode];
  const tracks = `clamp(${m.first}px, calc((100% - ${SASH}px) * ${ratio}), calc(100% - ${SASH + m.second}px)) ${SASH}px minmax(${m.second}px, 1fr)`;

  /** 拖曳分隔線調整比例（記住，下次打開一樣）：記下按下時滑鼠跟分隔線的距離，拖的時候不會跳 */
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const r = bodyRef.current!.getBoundingClientRect();
    const sashR = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const grab = mode === 'stacked' ? e.clientY - sashR.top : e.clientX - sashR.left;
    const pad = 4; // .editor-body 的 padding
    const total = (mode === 'stacked' ? r.height : r.width) - SASH - pad * 2;
    const mv = (ev: PointerEvent) => {
      const pos = (mode === 'stacked' ? ev.clientY - r.top : ev.clientX - r.left) - pad - grab;
      const v = Math.min(total - m.second, Math.max(m.first, pos)) / total;
      useLayout.getState().set({ editorSplit: { ...useLayout.getState().editorSplit, [mode]: v } });
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove(mode === 'stacked' ? 'resizing-h' : 'resizing-v');
    };
    document.body.classList.add(mode === 'stacked' ? 'resizing-h' : 'resizing-v');
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const props = <div className="editor-props" key="props"><Slot host={hosts.inspector} /></div>;
  const preview = <div className="editor-preview" key="preview"><Slot host={hosts.preview} /></div>;
  const sash = <div key="sash" className={`editor-sash ${mode}`} onPointerDown={drag} onDoubleClick={() => useLayout.getState().set({ editorSplit: { ...split, [mode]: mode === 'stacked' ? 0.6 : 0.42 } })} />;

  // 排版切換：三個固定位置的圖示按鈕（文字會變長變短的單一按鈕，連點時位置會跑掉）
  const layouts = [
    { id: 'auto', icon: <Sparkles size={14} />, label: $t('自動排版：橫式輸出時預覽在上，直式輸出時屬性在左') },
    { id: 'stacked', icon: <Rows2 size={14} />, label: $t('預覽在上、屬性在下') },
    { id: 'side', icon: <Columns2 size={14} />, label: $t('屬性在左、預覽在右') },
  ] as const;

  return (
    <div className="overlay editor-overlay">
      <div className={`editor-window ${mode}`} role="dialog" aria-label={$t('編輯視窗')}>
        <div className="editor-head">
          <span className="editor-title">{$t('編輯視窗')}</span>
          {name && <span className="editor-name">{name}</span>}
          <span className="spacer" />
          <div className="seg editor-layouts">
            {layouts.map((l) => (
              <button key={l.id} className={pref === l.id ? 'on' : ''} title={l.label} onClick={() => useLayout.getState().set({ editorLayout: l.id })}>
                {l.icon}
              </button>
            ))}
          </div>
          <button className="btn primary small-h" title={$t('完成 (Ctrl+Enter)')} onClick={closeEditorWindow}>{$t('完成')}</button>
          <button className="title-icon" title={$t('取消 (Esc)')} onClick={() => void cancelEditorWindow()}><X size={16} /></button>
        </div>
        <div
          ref={bodyRef}
          className="editor-body"
          style={mode === 'stacked' ? { gridTemplateRows: tracks } : { gridTemplateColumns: tracks }}
        >
          {mode === 'stacked' ? [preview, sash, props] : [props, sash, preview]}
        </div>
      </div>
    </div>
  );
}
