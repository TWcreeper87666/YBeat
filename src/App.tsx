import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { projectDuration, useStore } from './store';
import { InspectorPanel, MediaPanel, ModulePanel } from './ui/LeftPanel';
import { Timeline } from './ui/Timeline';
import { FloatingWindow, PreviewPanel, Slot } from './ui/PreviewPanel';
import { DockRoot, PANELS, layoutMenuItems, panelMenuItems, useDock, type PanelId } from './ui/Dock';
import { MenuBar, MenuHost, Toasts } from './ui/Menu';
import { deleteSelectedKey } from './ui/EffectControls';
import { useLayout, toast, stopPreviewFx, type MenuItem } from './ui/uiStore';
import { downloadBlob, exportMp4 } from './engine/exporter';
import { loadDemo } from './engine/demo';
import { undo, redo, useHistory } from './engine/history';
import { newProject, saveNow, useSaveState } from './engine/project';
import { importFiles, pickFiles } from './engine/media';

const FPS = 60;

// ───────────── 對話框 ─────────────

type Dialog = 'export' | 'shortcuts' | 'about' | 'new' | 'demo' | 'saveLayout' | null;
let setDialogGlobal: (d: Dialog) => void = () => {};
const openDialog = (d: Dialog) => setDialogGlobal(d);

function ExportDialog({ close }: { close: () => void }) {
  const [fps, setFps] = useState(60);
  const dur = useStore((s) => projectDuration(s));
  const go = async () => {
    close();
    try {
      downloadBlob(await exportMp4(fps), `edit_${Date.now()}.mp4`);
      toast('匯出完成');
    } catch (e) {
      toast(`匯出失敗：${e instanceof Error ? e.message : e}`, 'error');
    }
  };
  return (
    <div className="dialog">
      <h3>匯出影片</h3>
      <div className="form-row"><span>解析度</span><b>1080 × 1920（9:16）</b></div>
      <div className="form-row">
        <span>影格率</span>
        <div className="seg">
          {[30, 60].map((f) => <button key={f} className={fps === f ? 'on' : ''} onClick={() => setFps(f)}>{f} fps</button>)}
        </div>
      </div>
      <div className="form-row"><span>長度</span><b>{dur.toFixed(2)} 秒</b></div>
      <div className="form-row"><span>格式</span><b>MP4（H.264 + AAC）</b></div>
      <div className="dialog-actions">
        <button className="btn" onClick={close}>取消</button>
        <button className="btn primary" disabled={dur <= 0} onClick={go}>開始匯出</button>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Space', '播放 / 暫停'],
  ['← / →', '上 / 下一格（Shift = 1 秒）'],
  ['↑ / ↓', '跳到上 / 下一個剪接點'],
  ['Home / End', '跳到開頭 / 結尾'],
  ['S、Ctrl+B', '在播放頭分割'],
  ['Q / W', '修剪開頭 / 結尾到播放頭'],
  ['Ctrl+C / X / V', '複製 / 剪下 / 貼上到播放頭'],
  ['Ctrl+D', '再製'],
  ['Delete', '刪除'],
  ['Shift+Delete', '波紋刪除'],
  ['Alt+← / →', '選取的項目移動一格（Shift = 10 格）'],
  ['Ctrl+A', '全選'],
  ['Esc', '取消選取 / 停止循環'],
  ['Ctrl+點擊', '加選 / 取消選取'],
  ['Shift+點擊', '選取同軌範圍'],
  ['空白處拖曳', '框選'],
  ['Ctrl+Z / Ctrl+Shift+Z、Ctrl+Y', '復原 / 重做'],
  ['N', '磁吸開關'],
  ['= / -、\\', '時間軸放大 / 縮小、符合視窗'],
  ['Ctrl+滾輪', '時間軸縮放'],
  ['Ctrl+O', '匯入媒體'],
  ['Ctrl+E', '匯出影片'],
  ['Ctrl+S', '立即存檔（平常會自動存）'],
  ['F1', '快捷鍵一覽'],
  ['數值欄', '左右拖曳改值（Shift 微調、Ctrl 對齊）；單擊輸入，可輸入算式'],
];

function ShortcutsDialog({ close }: { close: () => void }) {
  return (
    <div className="dialog wide">
      <h3>快捷鍵</h3>
      <div className="shortcut-grid">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="sc-row"><kbd>{k}</kbd><span>{v}</span></div>
        ))}
      </div>
      <div className="dialog-actions"><button className="btn primary" onClick={close}>關閉</button></div>
    </div>
  );
}

function NewDialog({ close }: { close: () => void }) {
  return (
    <div className="dialog">
      <h3>建立新專案？</h3>
      <p className="muted">目前的時間軸與素材會被清空（模組程式碼會保留）。此動作無法復原。</p>
      <div className="dialog-actions">
        <button className="btn" onClick={close}>取消</button>
        <button className="btn danger-fill" onClick={() => { close(); newProject(); }}>清空並建立</button>
      </div>
    </div>
  );
}

function SaveLayoutDialog({ close }: { close: () => void }) {
  const n = useDock((s) => s.customs.length);
  const [name, setName] = useState(`自訂版面 ${n + 1}`);
  const save = () => {
    useDock.getState().saveCustom(name.trim() || `自訂版面 ${n + 1}`);
    toast('版面已儲存，可以在「版面」選單切換');
    close();
  };
  return (
    <div className="dialog">
      <h3>另存目前版面</h3>
      <input className="text-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') save(); if (e.key === 'Escape') close(); }} />
      <div className="dialog-actions">
        <button className="btn" onClick={close}>取消</button>
        <button className="btn primary" onClick={save}>儲存</button>
      </div>
    </div>
  );
}

function Dialogs() {
  const [d, setD] = useState<Dialog>(null);
  setDialogGlobal = setD;
  useEffect(() => {
    if (!d) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setD(null);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [d]);
  if (!d) return null;
  const close = () => setD(null);
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      {d === 'export' && <ExportDialog close={close} />}
      {d === 'shortcuts' && <ShortcutsDialog close={close} />}
      {d === 'new' && <NewDialog close={close} />}
      {d === 'saveLayout' && <SaveLayoutDialog close={close} />}
      {d === 'demo' && (
        <div className="dialog">
          <h3>載入示範專案？</h3>
          <p className="muted">示範會取代目前的時間軸（素材庫保留）。之後可以用 Ctrl+Z 復原。</p>
          <div className="dialog-actions">
            <button className="btn" onClick={close}>取消</button>
            <button className="btn primary" onClick={() => { close(); loadDemo(); }}>載入示範</button>
          </div>
        </div>
      )}
      {d === 'about' && (
        <div className="dialog">
          <h3>BeatSync Editor</h3>
          <p className="muted">程式化短影音剪輯器。特效、轉場、變速都是可即時修改的程式碼模組。</p>
          <div className="dialog-actions"><button className="btn primary" onClick={close}>關閉</button></div>
        </div>
      )}
    </div>
  );
}

function ExportOverlay() {
  const ex = useStore((s) => s.exporting);
  if (!ex) return null;
  return (
    <div className="overlay">
      <div className="dialog">
        <h3>匯出中… {(ex.progress * 100).toFixed(0)}%</h3>
        <div className="bar"><div style={{ width: `${ex.progress * 100}%` }} /></div>
        <p className="muted small">逐幀渲染 + 混音，不會掉幀。影片素材需要精準 seek，所以會比即時慢一些。</p>
        <div className="dialog-actions">
          <button className="btn" onClick={() => useStore.setState({ exporting: { ...ex, cancel: true } })}>取消</button>
        </div>
      </div>
    </div>
  );
}

// ───────────── 選單內容 ─────────────

function menus(): { label: string; items: () => MenuItem[] }[] {
  const S = () => useStore.getState();
  return [
    {
      label: '檔案',
      items: () => [
        { label: '新專案…', action: () => openDialog('new') },
        { label: '匯入媒體…', shortcut: 'Ctrl+O', action: async () => importFiles(await pickFiles()) },
        { label: '載入示範專案…', action: () => (projectDuration(S()) > 0 ? openDialog('demo') : loadDemo()) },
        { separator: true },
        { label: '立即存檔', shortcut: 'Ctrl+S', action: () => saveNow().then(() => toast('已儲存')) },
        { label: '匯出影片…', shortcut: 'Ctrl+E', action: () => openDialog('export') },
      ],
    },
    {
      label: '編輯',
      items: () => {
        const s = S();
        const h = useHistory.getState();
        const has = s.selected.length > 0;
        return [
          { label: '復原', shortcut: 'Ctrl+Z', action: h.canUndo ? undo : undefined },
          { label: '重做', shortcut: 'Ctrl+Shift+Z', action: h.canRedo ? redo : undefined },
          { separator: true },
          { label: '剪下', shortcut: 'Ctrl+X', action: has ? s.cut : undefined },
          { label: '複製', shortcut: 'Ctrl+C', action: has ? s.copy : undefined },
          { label: '貼上', shortcut: 'Ctrl+V', action: s.clipboard ? () => s.paste() : undefined },
          { label: '再製', shortcut: 'Ctrl+D', action: has ? s.duplicate : undefined },
          { label: '刪除', shortcut: 'Del', action: s.selection ? () => s.removeSelection() : undefined },
          { label: '波紋刪除', shortcut: 'Shift+Del', action: has ? () => s.removeSelection(true) : undefined },
          { separator: true },
          { label: '在播放頭分割', shortcut: 'S', action: s.split },
          { label: '修剪開頭到播放頭', shortcut: 'Q', action: () => s.trim('start') },
          { label: '修剪結尾到播放頭', shortcut: 'W', action: () => s.trim('end') },
          { separator: true },
          { label: '全選', shortcut: 'Ctrl+A', action: s.selectAll },
          { label: '取消選取', shortcut: 'Esc', action: () => s.select(null) },
        ];
      },
    },
    {
      label: '檢視',
      items: () => {
        const L = useLayout.getState();
        const s = S();
        return [
          ...panelMenuItems(),
          { separator: true },
          { label: '預覽：浮動視窗', checked: L.floating, action: () => L.set({ floating: !L.floating }) },
          { label: '磁吸對齊', shortcut: 'N', checked: s.snap, action: () => s.setSnap(!s.snap) },
          { separator: true },
          { label: '時間軸放大', shortcut: '=', action: () => s.setPps(s.pps * 1.25) },
          { label: '時間軸縮小', shortcut: '-', action: () => s.setPps(s.pps / 1.25) },
          { label: '時間軸符合視窗', shortcut: '\\', action: () => window.dispatchEvent(new Event('timeline-fit')) },
          { separator: true },

        ];
      },
    },
    { label: '版面', items: () => layoutMenuItems(() => openDialog('saveLayout')) },
    {
      label: '說明',
      items: () => [
        { label: '快捷鍵一覽', shortcut: 'F1', action: () => openDialog('shortcuts') },
        { label: '關於', action: () => openDialog('about') },
      ],
    },
  ];
}

function SaveIndicator() {
  const st = useSaveState((s) => s.state);
  return <span className={`save-ind ${st}`}>{st === 'saved' ? '✓ 已自動儲存' : st === 'saving' ? '儲存中…' : '● 未儲存'}</span>;
}

// ───────────── 快捷鍵 ─────────────

function editPoints() {
  const s = useStore.getState();
  const pts = new Set<number>([0]);
  for (const c of [...s.clips, ...s.audios]) {
    pts.add(+c.start.toFixed(4));
    pts.add(+(c.start + c.duration).toFixed(4));
  }
  return [...pts].sort((a, b) => a - b);
}

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  if (el instanceof Element && el.closest('input, textarea, select, .cm-editor, [contenteditable]')) return;
  const s = useStore.getState();
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const frame = 1 / FPS;
  if (mod) {
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 'c') s.copy();
    else if (k === 'x') s.cut();
    else if (k === 'v') s.paste();
    else if (k === 'd') { e.preventDefault(); s.duplicate(); }
    else if (k === 'b') { e.preventDefault(); s.split(); }
    else if (k === 'a') { e.preventDefault(); s.selectAll(); }
    else if (k === 's') { e.preventDefault(); saveNow().then(() => toast('已儲存')); }
    else if (k === 'o') { e.preventDefault(); pickFiles().then(importFiles); }
    else if (k === 'e') { e.preventDefault(); openDialog('export'); }
    return;
  }
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    return s.nudge((e.key === 'ArrowLeft' ? -1 : 1) * frame * (e.shiftKey ? 10 : 1));
  }
  switch (e.key) {
    case ' ': e.preventDefault(); s.togglePlay(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); if (!deleteSelectedKey()) s.removeSelection(e.shiftKey); break;
    case 'Home': s.setTime(0); break;
    case 'End': s.setTime(projectDuration(s)); break;
    case 'ArrowLeft': e.preventDefault(); s.setTime(s.time - (e.shiftKey ? 1 : frame)); break;
    case 'ArrowRight': e.preventDefault(); s.setTime(s.time + (e.shiftKey ? 1 : frame)); break;
    case 'ArrowUp': { e.preventDefault(); const p = editPoints().filter((t) => t < s.time - 1e-3); if (p.length) s.setTime(p[p.length - 1]); break; }
    case 'ArrowDown': { e.preventDefault(); const p = editPoints().find((t) => t > s.time + 1e-3); if (p !== undefined) s.setTime(p); break; }
    case 'Escape': stopPreviewFx(); s.setLoop(null); s.select(null); break;
    case 'F1': e.preventDefault(); openDialog('shortcuts'); break;
    case '=': case '+': s.setPps(s.pps * 1.25); break;
    case '-': s.setPps(s.pps / 1.25); break;
    case '\\': window.dispatchEvent(new Event('timeline-fit')); break;
    default:
      if (k === 's') s.split();
      else if (k === 'q') s.trim('start');
      else if (k === 'w') s.trim('end');
      else if (k === 'n') { s.setSnap(!s.snap); toast(`磁吸：${!s.snap ? '開' : '關'}`); }
  }
}

// ───────────── App ─────────────

export default function App() {
  const L = useLayout();
  // 每個面板一個固定的 DOM 節點；移動分頁時只搬節點，元件不會重建（預覽的 WebGL 不會重置）
  const hosts = useMemo(() => {
    const h = {} as Record<PanelId, HTMLElement>;
    for (const p of PANELS) {
      const d = document.createElement('div');
      d.className = `panel-host panel-${p.id}`;
      h[p.id] = d;
    }
    return h;
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    const warn = (e: BeforeUnloadEvent) => {
      if (useStore.getState().exporting) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', warn);
    };
  }, []);

  const menuDefs = useMemo(menus, []);

  return (
    <div className="app" style={{ gridTemplateRows: '34px minmax(0, 1fr)' }}>
      <header className="titlebar">
        <div className="brand">BeatSync<span>Editor</span></div>
        <MenuBar menus={menuDefs} />
        <span className="spacer" />
        <SaveIndicator />
        <button className="btn primary small-h" onClick={() => openDialog('export')}>匯出影片</button>
      </header>

      <DockRoot hosts={hosts} />

      {L.floating && (
        <FloatingWindow title="預覽">
          <Slot host={hosts.preview} />
        </FloatingWindow>
      )}
      {createPortal(<MediaPanel />, hosts.media)}
      {createPortal(<ModulePanel kind="transition" />, hosts.transition)}
      {createPortal(<ModulePanel kind="effect" />, hosts.effect)}
      {createPortal(<ModulePanel kind="remap" />, hosts.remap)}
      {createPortal(<InspectorPanel />, hosts.inspector)}
      {createPortal(<PreviewPanel />, hosts.preview)}
      {createPortal(<Timeline />, hosts.timeline)}

      <ExportOverlay />
      <Dialogs />
      <MenuHost />
      <Toasts />
    </div>
  );
}
