import { $t, LANGS, lang, saveLang, type Lang } from './i18n';
import { Check, CircleDot, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { FORMATS, formatLabel, projectDuration, useStore } from './store';
import { InspectorPanel, MediaPanel, ModulePanel, TextPanel } from './ui/LeftPanel';
import { Timeline, mergeOrHint } from './ui/Timeline';
import { SourcePanel, sourceHotkey } from './ui/SourcePanel';
import { FloatingWindow, PreviewPanel, Slot } from './ui/PreviewPanel';
import { DockRoot, PANELS, layoutMenuItems, panelMenuItems, useDock, type PanelId } from './ui/Dock';
import { ConfirmHost, DragGhost, MenuBar, MenuHost, Toasts } from './ui/Menu';
import { copyKeys, deleteSelectedKey, keysFocused, nudgeKeys, pasteKeys, selectAllKeys } from './ui/EffectControls';
import { useLayout, toast, stopPreviewFx, confirmDialog, openMenu, type MenuItem } from './ui/uiStore';
import { Globe, Settings } from 'lucide-react';
import { downloadBlob, exportMp4 } from './engine/exporter';
import { loadDemo } from './engine/demo';
import { undo, redo, useHistory } from './engine/history';
import { newProject, saveNow, useSaveState } from './engine/project';
import { importFiles, pickFiles } from './engine/media';

const FPS = 60;

// ───────────── 對話框 ─────────────

type Dialog = 'export' | 'shortcuts' | 'about' | 'new' | 'demo' | 'saveLayout' | 'settings' | null;
let setDialogGlobal: (d: Dialog) => void = () => {};
const openDialog = (d: Dialog) => setDialogGlobal(d);

function ExportDialog({ close }: { close: () => void }) {
  const [fps, setFps] = useState(60);
  const dur = useStore((s) => projectDuration(s));
  const fmt = useStore((s) => s.format);
  const go = async () => {
    close();
    try {
      downloadBlob(await exportMp4(fps), `edit_${Date.now()}.mp4`);
      toast($t('匯出完成'));
    } catch (e) {
      toast($t('匯出失敗：{0}', e instanceof Error ? e.message : e), 'error');
    }
  };
  return (
    <div className="dialog">
      <h3>{$t('匯出影片')}</h3>
      <div className="form-row"><span>{$t('解析度')}</span><b>{fmt.w} × {fmt.h}（{formatLabel(fmt)}）</b></div>
      <div className="form-row">
        <span>{$t('影格率')}</span>
        <div className="seg">
          {[30, 60].map((f) => <button key={f} className={fps === f ? 'on' : ''} onClick={() => setFps(f)}>{f} fps</button>)}
        </div>
      </div>
      <div className="form-row"><span>{$t('長度')}</span><b>{dur.toFixed(2)}{' '}{$t('秒')}</b></div>
      <div className="form-row"><span>{$t('格式')}</span><b>{$t('MP4（H.264 + AAC）')}</b></div>
      <div className="dialog-actions">
        <button className="btn" onClick={close}>{$t('取消')}</button>
        <button className="btn primary" disabled={dur <= 0} onClick={go}>{$t('開始匯出')}</button>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Space', $t('播放 / 暫停')],
  ['← / →', $t('上 / 下一格（Shift = 1 秒）')],
  ['↑ / ↓', $t('跳到上 / 下一個剪接點')],
  ['Home / End', $t('跳到開頭 / 結尾（有選取時跳到選取片段的頭尾）')],
  ['Ctrl+J', $t('合併相接的片段')],
  ['Ctrl+G / Ctrl+Shift+G', $t('建立 / 解除群組')],
  [$t('S、Ctrl+B'), $t('在播放頭分割')],
  ['Q / W', $t('修剪開頭 / 結尾到播放頭')],
  ['Ctrl+C / X / V', $t('複製 / 剪下 / 貼上到播放頭')],
  ['Ctrl+D', $t('再製')],
  ['Delete', $t('刪除')],
  ['Shift+Delete', $t('波紋刪除')],
  ['Alt+← / →', $t('選取的項目移動一格（Shift = 10 格）')],
  ['Ctrl+A', $t('全選')],
  ['Esc', $t('取消選取 / 停止循環')],
  [$t('Ctrl+點擊'), $t('加選 / 取消選取')],
  [$t('Shift+點擊'), $t('選取同軌範圍')],
  [$t('空白處拖曳'), $t('框選')],
  [$t('Ctrl+Z / Ctrl+Shift+Z、Ctrl+Y'), $t('復原 / 重做')],
  ['N', $t('磁吸開關')],
  [$t('= / -、\\'), $t('時間軸放大 / 縮小、符合視窗')],
  [$t('Ctrl+滾輪'), $t('時間軸縮放')],
  ['Ctrl+O', $t('匯入媒體')],
  ['Ctrl+E', $t('匯出影片')],
  ['Ctrl+S', $t('立即存檔（平常會自動存）')],
  ['F1', $t('快捷鍵一覽')],
  [$t('數值欄'), $t('左右拖曳改值（Shift 微調、Ctrl 對齊）；單擊輸入，可輸入算式')],
];

function ShortcutsDialog({ close }: { close: () => void }) {
  return (
    <div className="dialog wide">
      <h3>{$t('快捷鍵')}</h3>
      <div className="shortcut-grid">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="sc-row"><kbd>{k}</kbd><span>{v}</span></div>
        ))}
      </div>
      <div className="dialog-actions"><button className="btn primary" onClick={close}>{$t('關閉')}</button></div>
    </div>
  );
}

function NewDialog({ close }: { close: () => void }) {
  return (
    <div className="dialog">
      <h3>{$t('建立新專案？')}</h3>
      <p className="muted">{$t('目前的時間軸與素材會被清空（模組程式碼會保留）。此動作無法復原。')}</p>
      <div className="dialog-actions">
        <button className="btn" onClick={close}>{$t('取消')}</button>
        <button className="btn danger-fill" onClick={() => { close(); newProject(); }}>{$t('清空並建立')}</button>
      </div>
    </div>
  );
}

function SaveLayoutDialog({ close }: { close: () => void }) {
  const n = useDock((s) => s.customs.length);
  const [name, setName] = useState($t('自訂版面 {0}', n + 1));
  const save = () => {
    useDock.getState().saveCustom(name.trim() || $t('自訂版面 {0}', n + 1));
    toast($t('版面已儲存，可以在「版面」選單切換'));
    close();
  };
  return (
    <div className="dialog">
      <h3>{$t('另存目前版面')}</h3>
      <input className="text-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') save(); if (e.key === 'Escape') close(); }} />
      <div className="dialog-actions">
        <button className="btn" onClick={close}>{$t('取消')}</button>
        <button className="btn primary" onClick={save}>{$t('儲存')}</button>
      </div>
    </div>
  );
}

// ───────────── 設定 ─────────────

const QUALITIES = [1, 0.75, 0.5, 0.33];

function SettingsDialog({ close }: { close: () => void }) {
  const L = useLayout();
  const fmt = useStore((s) => s.format);
  return (
    <div className="dialog wide settings">
      <h3>{$t('設定')}</h3>
      <div className="set-sec">{$t('專案')}</div>
      <div className="form-row col">
        <span>{$t('輸出比例')}</span>
        <div className="seg wrap">
          {FORMATS.map((f) => (
            <button key={f.id} className={fmt.w === f.w && fmt.h === f.h ? 'on' : ''} onClick={() => useStore.getState().setFormat(f)} title={`${f.w} × ${f.h}`}>
              <span className="ratio-box" style={{ aspectRatio: `${f.w} / ${f.h}` }} />
              {f.label}
            </button>
          ))}
        </div>
        <small className="muted">{fmt.w} × {fmt.h}</small>
      </div>
      <div className="set-sec">{$t('預覽')}</div>
      <div className="form-row col">
        <span>{$t('預覽畫質')}</span>
        <div className="seg">
          {QUALITIES.map((q) => (
            <button key={q} className={L.previewScale === q ? 'on' : ''} onClick={() => L.set({ previewScale: q })}>
              {q === 1 ? $t('完整') : `${Math.round(q * 100)}%`}
            </button>
          ))}
        </div>
        <small className="muted">{$t('降低預覽解析度可以減少 GPU 負擔，特效多、素材大時編輯會比較順。匯出一律是完整解析度。')}</small>
      </div>
      <div className="set-sec">{$t('時間軸')}</div>
      <div className="form-row col">
        <span>{$t('上層軌道（畫面中蓋在上面的）顯示在')}</span>
        <div className="seg">
          <button className={L.upperLayerAt === 'bottom' ? 'on' : ''} onClick={() => L.set({ upperLayerAt: 'bottom' })}>{$t('下方')}</button>
          <button className={L.upperLayerAt === 'top' ? 'on' : ''} onClick={() => L.set({ upperLayerAt: 'top' })}>{$t('上方')}</button>
        </div>
      </div>
      <div className="set-sec">{$t('語言')} / Language</div>
      <div className="form-row col">
        <div className="seg">
          {LANGS.map((l) => (
            <button key={l.id} className={lang === l.id ? 'on' : ''} onClick={() => changeLanguage(l.id)}>{l.label}</button>
          ))}
        </div>
      </div>
      <div className="dialog-actions"><button className="btn primary" onClick={close}>{$t('完成')}</button></div>
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
          <h3>{$t('載入示範專案？')}</h3>
          <p className="muted">{$t('示範會取代目前的時間軸（素材庫保留）。之後可以用 Ctrl+Z 復原。')}</p>
          <div className="dialog-actions">
            <button className="btn" onClick={close}>{$t('取消')}</button>
            <button className="btn primary" onClick={() => { close(); loadDemo(); }}>{$t('載入示範')}</button>
          </div>
        </div>
      )}
      {d === 'settings' && <SettingsDialog close={close} />}
      {d === 'about' && (
        <div className="dialog">
          <h3>YBeat</h3>
          <p className="muted">{$t('程式化短影音剪輯器。特效、轉場、變速都是可即時修改的程式碼模組。')}</p>
          <div className="dialog-actions"><button className="btn primary" onClick={close}>{$t('關閉')}</button></div>
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
        <h3>{$t('匯出中…')}{' '}{(ex.progress * 100).toFixed(0)}%</h3>
        <div className="bar"><div style={{ width: `${ex.progress * 100}%` }} /></div>
        <p className="muted small">{$t('逐幀渲染 + 混音，不會掉幀。影片素材需要精準 seek，所以會比即時慢一些。')}</p>
        <div className="dialog-actions">
          <button className="btn" onClick={() => useStore.setState({ exporting: { ...ex, cancel: true } })}>{$t('取消')}</button>
        </div>
      </div>
    </div>
  );
}

// ───────────── 語言 ─────────────

/** 切換語言：存檔後重新整理（文字都在載入時決定） */
async function changeLanguage(l: Lang) {
  if (l === lang) return;
  const ok = await confirmDialog({ title: $t('切換語言？'), message: $t('切換語言會重新整理頁面（專案已自動儲存，但復原紀錄會清空）。'), ok: $t('切換') });
  if (!ok) return;
  await saveNow().catch(() => {});
  saveLang(l);
  location.reload();
}

// ───────────── 選單內容 ─────────────

function menus(): { label: string; items: () => MenuItem[] }[] {
  const S = () => useStore.getState();
  return [
    {
      label: $t('檔案'),
      items: () => [
        { label: $t('新專案…'), action: () => openDialog('new') },
        { label: $t('匯入媒體…'), shortcut: 'Ctrl+O', action: async () => importFiles(await pickFiles()) },
        { label: $t('載入示範專案…'), action: () => (projectDuration(S()) > 0 ? openDialog('demo') : loadDemo()) },
        { separator: true },
        { label: $t('立即存檔'), shortcut: 'Ctrl+S', action: () => saveNow().then(() => toast($t('已儲存'))) },
        { label: $t('匯出影片…'), shortcut: 'Ctrl+E', action: () => openDialog('export') },
        { separator: true },
        { label: $t('設定…'), shortcut: 'Ctrl+,', action: () => openDialog('settings') },
      ],
    },
    {
      label: $t('編輯'),
      items: () => {
        const s = S();
        const h = useHistory.getState();
        const has = s.selected.length > 0;
        return [
          { label: $t('復原'), shortcut: 'Ctrl+Z', action: h.canUndo ? undo : undefined },
          { label: $t('重做'), shortcut: 'Ctrl+Shift+Z', action: h.canRedo ? redo : undefined },
          { separator: true },
          { label: $t('剪下'), shortcut: 'Ctrl+X', action: has ? s.cut : undefined },
          { label: $t('複製'), shortcut: 'Ctrl+C', action: has ? s.copy : undefined },
          { label: $t('貼上'), shortcut: 'Ctrl+V', action: s.clipboard ? () => s.paste() : undefined },
          { label: $t('再製'), shortcut: 'Ctrl+D', action: has ? s.duplicate : undefined },
          { label: $t('刪除'), shortcut: 'Del', action: s.selection ? () => s.removeSelection() : undefined },
          { label: $t('波紋刪除'), shortcut: 'Shift+Del', action: has ? () => s.removeSelection(true) : undefined },
          { separator: true },
          { label: $t('在播放頭分割'), shortcut: 'S', action: s.split },
          { label: $t('修剪開頭到播放頭'), shortcut: 'Q', action: () => s.trim('start') },
          { label: $t('修剪結尾到播放頭'), shortcut: 'W', action: () => s.trim('end') },
          { separator: true },
          { label: $t('全選'), shortcut: 'Ctrl+A', action: s.selectAll },
          { label: $t('取消選取'), shortcut: 'Esc', action: () => s.select(null) },
        ];
      },
    },
    {
      label: $t('檢視'),
      items: () => {
        const L = useLayout.getState();
        const s = S();
        return [
          ...panelMenuItems(),
          { separator: true },
          { label: $t('預覽：浮動視窗'), checked: L.floating, action: () => L.set({ floating: !L.floating }) },
          { label: $t('磁吸對齊'), shortcut: 'N', checked: s.snap, action: () => s.setSnap(!s.snap) },
          { separator: true },
          { label: $t('時間軸放大'), shortcut: '=', action: () => s.setPps(s.pps * 1.25) },
          { label: $t('時間軸縮小'), shortcut: '-', action: () => s.setPps(s.pps / 1.25) },
          { label: $t('時間軸符合視窗'), shortcut: '\\', action: () => window.dispatchEvent(new Event('timeline-fit')) },
          { separator: true },

        ];
      },
    },
    { label: $t('版面'), items: () => layoutMenuItems(() => openDialog('saveLayout')) },
    {
      label: $t('說明'),
      items: () => [
        { label: $t('快捷鍵一覽'), shortcut: 'F1', action: () => openDialog('shortcuts') },
        { label: $t('關於'), action: () => openDialog('about') },
      ],
    },
  ];
}

function SaveIndicator() {
  const st = useSaveState((s) => s.state);
  return <span className={`save-ind ${st}`}>{st === 'saved' ? <><Check size={12} /> {$t('已自動儲存')}</> : st === 'saving' ? <><LoaderCircle size={12} className="spin" /> {$t('儲存中…')}</> : <><CircleDot size={12} /> {$t('未儲存')}</>}</span>;
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

/** 選取項目的時間範圍（Home / End 跳到它的頭尾） */
function selRange(): { a: number; b: number } | null {
  const s = useStore.getState();
  const items = s.selected
    .map((k) => {
      const i = k.indexOf(':');
      const type = k.slice(0, i) as 'clip' | 'effect' | 'audio';
      const list = type === 'clip' ? s.clips : type === 'effect' ? s.effects : s.audios;
      return list.find((x) => x.id === k.slice(i + 1));
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!items.length) return null;
  return { a: Math.min(...items.map((x) => x.start)), b: Math.max(...items.map((x) => x.start + x.duration)) };
}

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  if (el instanceof Element && el.closest('input, textarea, select, .cm-editor, [contenteditable]')) return;
  const s = useStore.getState();
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const frame = 1 / FPS;
  // 滑鼠在素材預覽上：Space / I / O 給素材預覽
  if (sourceHotkey(e)) return;
  // 最後點的是屬性面板的關鍵影格區：快捷鍵作用在關鍵影格
  if (keysFocused()) {
    if (mod && k === 'c') return void (copyKeys() && toast($t('已複製關鍵影格')));
    if (mod && k === 'x') { if (copyKeys()) deleteSelectedKey(); return; }
    if (mod && k === 'v') { e.preventDefault(); return void pasteKeys(); }
    if (mod && k === 'a') { e.preventDefault(); return void selectAllKeys(); }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      return void nudgeKeys((e.key === 'ArrowLeft' ? -1 : 1) * frame * (e.shiftKey ? 10 : 1));
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelectedKey(); return; }
  }
  if (mod) {
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 'c') s.copy();
    else if (k === 'x') s.cut();
    else if (k === 'v') s.paste();
    else if (k === 'd') { e.preventDefault(); s.duplicate(); }
    else if (k === 'b') { e.preventDefault(); s.split(); }
    else if (k === 'a') { e.preventDefault(); s.selectAll(); }
    else if (k === 's') { e.preventDefault(); saveNow().then(() => toast($t('已儲存'))); }
    else if (k === 'o') { e.preventDefault(); pickFiles().then(importFiles); }
    else if (k === 'e') { e.preventDefault(); openDialog('export'); }
    else if (k === 'j') { e.preventDefault(); mergeOrHint(); }
    else if (k === 'g') { e.preventDefault(); if (e.shiftKey) s.ungroupSelected(); else if (!s.groupSelected()) toast($t('至少選兩個項目才能建立群組'), 'error'); }
    else if (k === ',') { e.preventDefault(); openDialog('settings'); }
    return;
  }
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    return s.nudge((e.key === 'ArrowLeft' ? -1 : 1) * frame * (e.shiftKey ? 10 : 1));
  }
  switch (e.key) {
    case ' ': e.preventDefault(); s.togglePlay(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); s.removeSelection(e.shiftKey); break;
    case 'Home': { const r = selRange(); s.setTime(r ? r.a : 0); break; }
    case 'End': { const r = selRange(); s.setTime(r ? r.b - 1 / FPS : projectDuration(s)); break; }
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
      else if (k === 'n') { s.setSnap(!s.snap); toast($t('磁吸：{0}', !s.snap ? $t('開') : $t('關'))); }
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
        <div className="brand"><span>YB</span>eat</div>
        <MenuBar menus={menuDefs} />
        <span className="spacer" />
        <SaveIndicator />
        <button
          className="title-icon"
          title={$t('語言') + ' / Language'}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left, r.bottom + 4, LANGS.map((l) => ({ label: l.label, checked: lang === l.id, action: () => changeLanguage(l.id) })));
          }}
        >
          <Globe size={15} />
          <span>{LANGS.find((l) => l.id === lang)!.label}</span>
        </button>
        <button className="title-icon" title={$t('設定') + ' (Ctrl+,)'} onClick={() => openDialog('settings')}>
          <Settings size={15} />
        </button>
        <button className="btn primary small-h" onClick={() => openDialog('export')}>{$t('匯出影片')}</button>
      </header>

      <DockRoot hosts={hosts} />

      {L.floating && (
        <FloatingWindow title={$t('預覽')}>
          <Slot host={hosts.preview} />
        </FloatingWindow>
      )}
      {createPortal(<MediaPanel />, hosts.media)}
      {createPortal(<TextPanel />, hosts.text)}
      {createPortal(<SourcePanel />, hosts.source)}
      {createPortal(<ModulePanel kind="transition" />, hosts.transition)}
      {createPortal(<ModulePanel kind="effect" />, hosts.effect)}
      {createPortal(<ModulePanel kind="remap" />, hosts.remap)}
      {createPortal(<InspectorPanel />, hosts.inspector)}
      {createPortal(<PreviewPanel />, hosts.preview)}
      {createPortal(<Timeline />, hosts.timeline)}

      <ExportOverlay />
      <Dialogs />
      <MenuHost />
      <ConfirmHost />
      <DragGhost />
      <Toasts />
    </div>
  );
}
