import { $t, LANGS, lang, saveLang, type Lang } from './i18n';
import { Check, CircleDot, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FORMATS, formatLabel, projectDuration, useStore } from './store';
import { InspectorPanel, MediaPanel, ModulePanel, TextPanel } from './ui/LeftPanel';
import { isTextField, modalOpen } from './ui/focus';
import { MaskPanel } from './ui/MaskPanel';
import { navEdge, navItem, navRow } from './ui/trackNav';
import { copyTransition, cutTransitions, navTransition, navTransitionEdge, navTransitionRow, pasteTransition, removeTransitions, selectAllTransitions, trSelRange } from './ui/trSelect';
import { CodePanel } from './ui/CodePanel';
import { AiPanel } from './ui/AiPanel';
import { PickerHost } from './ui/Library';
import { parseRowKey, useTrackSel } from './ui/trackSel';
import { Timeline, deleteTracks, duplicateTimeline, mergeOrHint, pasteTimeline } from './ui/Timeline';
import { closeSource, sourceHotkey } from './ui/SourcePanel';
import { FloatingWindow, PreviewPanel, Slot } from './ui/PreviewPanel';
import { DockRoot, PANELS, layoutMenuItems, panelMenuItems, useDock, type PanelId } from './ui/Dock';
import { ConfirmHost, DragGhost, MenuBar, MenuHost, Toasts } from './ui/Menu';
import { fps } from './engine/rulerTicks';
import { copyHits, copyKeys, cutHits, deleteSelectedHit, deleteSelectedKey, duplicateHits, hitEdge, hitsFocused, keysFocused, navHit, navHitEdge, nudgeHits, nudgeKeys, pasteHits, pasteKeys, selectAllHits, selectAllKeys, splitHit, trimHit } from './ui/EffectControls';
import { ShapeDrawerHost } from './ui/ShapeDrawer';
import { SHORTCUTS, TUTORIAL } from './ui/helpText';
import { useLayout, toast, setBusy, stopPreviewFx, confirmDialog, openMenu, useConfirm, type MenuItem } from './ui/uiStore';
import { DragNumber } from './ui/DragNumber';
import { usePrefs } from './prefs';
import { Globe, Settings } from 'lucide-react';
import { downloadBlob, exportMp4 } from './engine/exporter';
import { loadDemo } from './engine/demo';
import { beginHistoryTransaction, endHistoryTransaction, stepsFrom, undo, redo, useHistory } from './engine/history';
import { newProject, saveNow, useSaveState, exportProjectPack, importProjectPack } from './engine/project';
import { importFiles, pickFiles } from './engine/media';
import { LyricsPanel } from './ui/SubtitlesDialog';
import { AutoEditPanel } from './ui/AutoEditPanel';
import { canReplaceLast, generateAutoEdit } from './engine/autoEditApply';
import { ColorPanel } from './ui/ColorPanel';
import { EditorWindow, openEditorWindow, useEditorWindow } from './ui/EditorWindow';
import { snapToDevicePixels } from './ui/pixelSnap';
import { Seg, Switch } from './ui/Toggle';


// ───────────── 對話框 ─────────────

type Dialog = 'export' | 'shortcuts' | 'tutorial' | 'about' | 'new' | 'demo' | 'saveLayout' | 'settings' | null;
let setDialogGlobal: (d: Dialog) => void = () => {};
/**
 * 目前視窗的鍵盤行為（視窗在 render 時設定）：
 * Ctrl+Enter = save（沒有就是關閉）；Esc / 點外面 = 取消，dirty() 為真時先確認，確認後 revert()
 */
type DialogGuard = { save?: () => void; dirty?: () => boolean; revert?: () => void };
let guard: DialogGuard = {};
const openDialog = (d: Dialog) => setDialogGlobal(d);

function ExportDialog({ close }: { close: () => void }) {
  const [fps, setFps] = useState(60);
  const [quality, setQuality] = useState(20);
  const [filename, setFilename] = useState('YBeat_export');
  const full = useStore((s) => projectDuration(s));
  const loop = useStore((s) => s.loop);
  const [onlyLoop, setOnlyLoop] = useState(!!loop);
  const range = onlyLoop && loop ? { a: loop.a, b: Math.min(loop.b, full) } : undefined;
  const dur = range ? Math.max(0, range.b - range.a) : full;
  const fmt = useStore((s) => s.format);
  const go = async () => {
    close();
    try {
      downloadBlob(await exportMp4(fps, range, quality * 1_000_000), `${filename.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\.mp4$/i, '') || 'YBeat_export'}.mp4`);
      toast($t('匯出完成'));
    } catch (e) {
      toast($t('匯出失敗：{0}', e instanceof Error ? e.message : e), 'error');
    }
  };
  guard = { save: () => void go() };
  return (
    <div className="dialog settings export-window" role="dialog" aria-modal="true" aria-label={$t('匯出影片')}>
      <h3>{$t('匯出影片')}</h3>
      <div className="export-content">
        <div className="set-sec">{$t('檔案')}</div>
        <label className="form-row col"><span>{$t('檔名')}</span><input className="text-input" value={filename} onChange={(e) => setFilename(e.target.value)} /></label>
        <div className="set-sec">{$t('影片')}</div>
        <div className="form-row"><span>{$t('解析度')}</span><b>{fmt.w} × {fmt.h} <span className="muted">({formatLabel(fmt)})</span></b></div>
        <div className="form-row col">
          <span>{$t('影格率')}</span>
          <Seg value={fps} on={setFps} opts={[24, 30, 60].map((f) => ({ v: f, label: `${f} fps` }))} />
        </div>
        <div className="form-row col"><span>{$t('品質')}</span><Seg value={quality} on={setQuality} opts={[{ v: 8, label: $t('較小檔案') }, { v: 20, label: $t('標準') }, { v: 35, label: $t('高品質') }]} /></div>
        {loop && <div className="form-row col">
          <span>{$t('範圍')}</span>
          <Seg value={onlyLoop} on={setOnlyLoop} opts={[{ v: false, label: $t('整個專案') }, { v: true, label: $t('循環範圍') }]} />
        </div>}
        <div className="export-summary">
          <div><span>{$t('長度')}</span><b>{dur.toFixed(2)} {$t('秒')}</b></div>
          <div><span>{$t('格式')}</span><b>{$t('MP4（H.264 + AAC）')}</b></div>
          <div><span>{$t('預估大小')}</span><b>≈ {Math.round(dur * (quality + 0.192) / 8)} MB</b></div>
        </div>
      </div>
      <div className="dialog-actions">
        <button className="btn" onClick={close}>{$t('取消')}</button>
        <button className="btn primary" disabled={dur <= 0} onClick={go}>{$t('開始匯出')}</button>
      </div>
    </div>
  );
}

function TutorialDialog({ close }: { close: () => void }) {
  return (
    <div className="dialog sheet tutorial">
      <h3>{$t('使用教學')}</h3>
      <div className="dialog-body tutorial-body">
        {TUTORIAL.map((sec) => (
          <section key={sec.title}>
            <h4>{sec.title}</h4>
            <ul>{sec.items.map((it) => <li key={it}>{it}</li>)}</ul>
          </section>
        ))}
        <p className="muted small">{$t('所有快捷鍵請看「說明 → 快捷鍵一覽」（F1）。')}</p>
      </div>
      <div className="dialog-actions"><button className="btn primary" onClick={close}>{$t('關閉')}</button></div>
    </div>
  );
}

function ShortcutsDialog({ close }: { close: () => void }) {
  return (
    <div className="dialog sheet">
      <h3>{$t('快捷鍵')}</h3>
      <div className="dialog-body">
        <div className="shortcut-grid">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="sc-row"><kbd>{k}</kbd><span>{v}</span></div>
          ))}
        </div>
      </div>
      <div className="dialog-actions"><button className="btn primary" onClick={close}>{$t('關閉')}</button></div>
    </div>
  );
}

function DemoDialog({ close }: { close: () => void }) {
  const ok = () => { close(); loadDemo(); };
  guard = { save: ok };
  return (
    <div className="dialog">
      <h3>{$t('載入示範專案？')}</h3>
      <p className="muted">{$t('示範會取代目前的時間軸（素材庫保留）。之後可以用 Ctrl+Z 復原。')}</p>
      <div className="dialog-actions">
        <button className="btn" onClick={close}>{$t('取消')}</button>
        <button className="btn primary" onClick={ok}>{$t('載入示範')}</button>
      </div>
    </div>
  );
}

function NewDialog({ close }: { close: () => void }) {
  const ok = () => { close(); newProject(); };
  guard = { save: ok };
  return (
    <div className="dialog">
      <h3>{$t('建立新專案？')}</h3>
      <p className="muted">{$t('目前的時間軸與素材會被清空（模組程式碼會保留）。此動作無法復原。')}</p>
      <div className="dialog-actions">
        <button className="btn" onClick={close}>{$t('取消')}</button>
        <button className="btn danger-fill" onClick={ok}>{$t('清空並建立')}</button>
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
  guard = { save };
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

/** 設定的一項：標題、副標題，下面是輸入；inline = 輸入放右邊（數值類） */
function SetRow({ label, desc, inline, children }: { label: string; desc: ReactNode; inline?: boolean; children: ReactNode }) {
  return (
    <div className={`set-row ${inline ? 'inline' : ''}`}>
      <div className="set-text">
        <div className="set-name">{label}</div>
        <div className="set-desc">{desc}</div>
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  );
}

function SettingsDialog({ close }: { close: () => void }) {
  const L = useLayout();
  const P = usePrefs();
  const fmt = useStore((s) => s.format);
  // 設定是即時套用的：打開時記下來，取消時還原
  const [orig] = useState(() => {
    const l = useLayout.getState(), p = usePrefs.getState();
    return {
      layout: { previewScale: l.previewScale, upperLayerAt: l.upperLayerAt, wheelScroll: l.wheelScroll, trackSize: l.trackSize, beatLead: l.beatLead, timeGrid: l.timeGrid },
      prefs: { stillDur: p.stillDur, transDur: p.transDur, autosave: p.autosave, proxy: p.proxy },
      format: useStore.getState().format,
    };
  });
  // 輸出比例在對話框裡怎麼切都只算一步復原；取消（還原）就不留紀錄
  useEffect(() => {
    beginHistoryTransaction();
    return () => endHistoryTransaction(true);
  }, []);
  guard = {
    save: close,
    dirty: () => {
      const l = useLayout.getState() as unknown as Record<string, unknown>, p = usePrefs.getState() as unknown as Record<string, unknown>;
      return Object.entries(orig.layout).some(([k, v]) => l[k] !== v) || Object.entries(orig.prefs).some(([k, v]) => p[k] !== v) || useStore.getState().format !== orig.format;
    },
    revert: () => {
      useLayout.getState().set(orig.layout);
      usePrefs.getState().set(orig.prefs);
      if (useStore.getState().format !== orig.format) useStore.getState().setFormat(orig.format);
    },
  };
  return (
    <div className="dialog sheet settings">
      <h3>{$t('設定')}</h3>
      <div className="dialog-body">
        <div className="set-sec">{$t('專案')}</div>
        <SetRow label={$t('輸出比例')} desc={<>{$t('匯出與預覽的畫面比例')} · {fmt.w} × {fmt.h}</>}>
          <Seg className="wrap" value={FORMATS.find((f) => fmt.w === f.w && fmt.h === f.h)?.id ?? ''} on={(id) => { const f = FORMATS.find((x) => x.id === id); if (f) useStore.getState().setFormat(f); }}
            opts={FORMATS.map((f) => ({ v: f.id, title: `${f.w} × ${f.h}`, label: <><span className="ratio-box" style={{ aspectRatio: `${f.w} / ${f.h}` }} />{f.label}</> }))} />
        </SetRow>
        <SetRow label={$t('自動儲存')} desc={$t('關閉後按 Ctrl+S 存檔')} inline>
          <Switch v={P.autosave} on={(v) => P.set({ autosave: v })} />
        </SetRow>
        <div className="set-sec">{$t('預覽')}</div>
        <SetRow label={$t('預覽畫質')} desc={$t('調低編輯會比較順，不影響匯出')}>
          <Seg value={L.previewScale} on={(q) => L.set({ previewScale: q })} opts={QUALITIES.map((q) => ({ v: q, label: q === 1 ? $t('完整') : `${Math.round(q * 100)}%` }))} />
        </SetRow>
        <SetRow label={$t('預覽代理檔')} desc={$t('關鍵影格很稀的影片，預覽改用小副本，不影響匯出')} inline>
          <Switch v={P.proxy} on={(v) => P.set({ proxy: v })} />
        </SetRow>
        <div className="set-sec">{$t('時間軸')}</div>
        <SetRow label={$t('上層軌道顯示在')} desc={$t('疊在上面的軌道放在時間軸的哪一邊')}>
          <Seg value={L.upperLayerAt} on={(v) => L.set({ upperLayerAt: v })} opts={[{ v: 'bottom' as const, label: $t('下方') }, { v: 'top' as const, label: $t('上方') }]} />
        </SetRow>
        <SetRow label={$t('軌道高度')} desc={$t('預設與新增的軌道')}>
          <Seg value={L.trackSize} on={(k) => L.set({ trackSize: k })} opts={[{ v: 's' as const, label: $t('小') }, { v: 'm' as const, label: $t('中') }, { v: 'l' as const, label: $t('大') }]} />
        </SetRow>
        <SetRow label={$t('滾輪捲動方向')} desc={$t('在時間軸上直接滾動滾輪時')}>
          <Seg value={L.wheelScroll === 'vertical' ? 'vertical' : 'horizontal'} on={(v) => L.set({ wheelScroll: v })} opts={[{ v: 'horizontal' as const, label: $t('水平') }, { v: 'vertical' as const, label: $t('垂直') }]} />
        </SetRow>
        <SetRow label={$t('圖片 / 色板 / 文字預設長度')} desc={$t('新加入時的長度')} inline>
          <DragNumber value={P.stillDur} min={0.1} max={60} step={0.1} def={2} suffix=" s" onChange={(v) => P.set({ stillDur: Math.round(v * 100) / 100 })} />
        </SetRow>
        <SetRow label={$t('轉場預設長度')} desc={$t('新加入轉場時的長度')} inline>
          <DragNumber value={P.transDur} min={0.05} max={5} step={0.05} def={0.4} suffix=" s" onChange={(v) => P.set({ transDur: Math.round(v * 100) / 100 })} />
        </SetRow>
        <SetRow label={$t('時間軸格線')} desc={$t('拖曳、吸附、節拍的最小單位')}>
          <Seg value={L.timeGrid} on={(n) => L.set({ timeGrid: n })} opts={([30, 60] as const).map((n) => ({ v: n, label: `1/${n} s` }))} />
        </SetRow>
        <SetRow label={$t('節拍提前')} desc={$t('節拍格線比聲音早一點，看起來才會對拍')} inline>
          <span className="set-hint">≈ {Math.round((L.beatLead / 60) * 1000)} ms</span>
          <DragNumber value={L.beatLead} min={0} max={30} step={1} decimals={0} def={4} suffix=" / 60 s" onChange={(v) => L.set({ beatLead: Math.round(v) })} />
        </SetRow>
        <div className="set-sec">{$t('語言')} / Language</div>
        <SetRow label={$t('介面語言')} desc={$t('切換後會重新載入')}>
          <Seg value={lang} on={changeLanguage} opts={LANGS.map((l) => ({ v: l.id, label: l.label }))} />
        </SetRow>
      </div>
      <div className="dialog-actions">
        <button className="btn" onClick={() => void cancelDialog()}>{$t('取消')}</button>
        <button className="btn primary" title={$t('完成 (Ctrl+Enter)')} onClick={close}>{$t('完成')}</button>
      </div>
    </div>
  );
}

let cancelDialog: () => Promise<void> = async () => {};

function Dialogs() {
  const [d, setD] = useState<Dialog>(null);
  setDialogGlobal = setD;
  const close = () => setD(null);
  /** Esc / 點外面 / 取消：有未套用的變更先確認 */
  cancelDialog = async () => {
    const g = guard;
    if (g.dirty?.()) {
      const ok = await confirmDialog({ title: $t('捨棄變更？'), message: $t('設定的變更還沒儲存。'), ok: $t('捨棄'), danger: true });
      if (!ok) return;
      g.revert?.();
    }
    close();
  };
  useEffect(() => {
    if (!d) return;
    const k = (e: KeyboardEvent) => {
      if (useConfirm.getState().req) return;
      if (e.key === 'Escape') void cancelDialog();
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.(); // 正在輸入的數值先套用
        (guard.save ?? close)();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [d]);
  if (!d) return null;
  guard = {};
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && void cancelDialog()}>
      {d === 'export' && <ExportDialog close={close} />}
      {d === 'shortcuts' && <ShortcutsDialog close={close} />}
      {d === 'tutorial' && <TutorialDialog close={close} />}
      {d === 'new' && <NewDialog close={close} />}
      {d === 'saveLayout' && <SaveLayoutDialog close={close} />}
      {d === 'demo' && <DemoDialog close={close} />}
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
    <div className="overlay export-overlay">
      <div className="dialog">
        <h3>{$t('匯出中…')}{' '}{(ex.progress * 100).toFixed(0)}%</h3>
        <div className="bar"><div style={{ width: `${ex.progress * 100}%` }} /></div>
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
        { label: $t('匯入專案包…'), action: async () => { const [file] = await pickFiles('.ybeat', false); if (!file) return; if (!await confirmDialog({ title: $t('匯入專案包？'), message: $t('目前專案會被取代，請先匯出專案包備份。'), ok: $t('匯入') })) return; try { await importProjectPack(file, (n, total) => setBusy($t('匯入專案包 {0}/{1}', n, total))); toast($t('專案包已匯入')); } catch (e) { toast($t('匯入失敗：{0}', e instanceof Error ? e.message : e), 'error'); } finally { setBusy(null); } } },
        { label: $t('匯出專案包…'), action: async () => { try { downloadBlob(await exportProjectPack((n, total) => setBusy($t('匯出專案包 {0}/{1}', n, total))), 'YBeat_project.ybeat'); toast($t('專案包已匯出')); } catch (e) { toast($t('匯出失敗：{0}', e instanceof Error ? e.message : e), 'error'); } finally { setBusy(null); } } },
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
          { label: $t('貼上'), shortcut: 'Ctrl+V', action: s.clipboard ? () => pasteTimeline() : undefined },
          { label: $t('再製'), shortcut: 'Ctrl+D', action: has ? duplicateTimeline : undefined },
          { label: $t('刪除'), shortcut: 'Del', action: s.selection ? () => s.removeSelection() : undefined },
          { label: $t('波紋刪除'), shortcut: 'Shift+Del', action: has ? () => s.removeSelection(true) : undefined },
          { label: $t('波紋刪除（所有軌道）'), shortcut: 'Alt+Del', action: has ? () => s.removeSelection('all') : undefined },
          { separator: true },
          { label: $t('在播放頭分割'), shortcut: 'S', action: s.split },
          { label: $t('修剪開頭到播放頭'), shortcut: 'Q', action: () => s.trim('start') },
          { label: $t('修剪結尾到播放頭'), shortcut: 'W', action: () => s.trim('end') },
          { separator: true },
          { label: $t('自動剪輯'), action: () => useDock.getState().activatePanel('auto') },
          { label: $t('自動剪輯：再一版'), action: canReplaceLast() ? () => void generateAutoEdit(true) : undefined },
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
          { label: $t('拖曳播放頭時播放聲音'), checked: L.scrubAudio, action: () => L.set({ scrubAudio: !L.scrubAudio }) },
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
        { label: $t('使用教學'), action: () => openDialog('tutorial') },
        { label: $t('快捷鍵一覽'), shortcut: 'F1', action: () => openDialog('shortcuts') },
        { label: $t('關於'), action: () => openDialog('about') },
      ],
    },
  ];
}

function SaveIndicator() {
  const st = useSaveState((s) => s.state);
  const auto = usePrefs((s) => s.autosave);
  useHistory((s) => s.ver);
  const unsaved = stepsFrom(useSaveState((s) => s.savedPath));
  return <span className={`save-ind ${st}`}>{st === 'saved' ? <><Check size={12} /> {auto ? $t('已自動儲存') : $t('已儲存')}</> : st === 'saving' ? <><LoaderCircle size={12} className="spin" /> {$t('儲存中…')}</> : <><CircleDot size={12} /> {!auto && unsaved > 0 ? $t('未儲存（{0}）', unsaved) : $t('未儲存')}</>}</span>;
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
  // 選取的是轉場：轉場的頭尾
  if (s.selection?.type === 'transition') return trSelRange();
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

/** 時間軸捲到看得到播放頭（時間沒變也要捲，例如已經在 0 秒時按 Home） */
const revealPlayhead = () => requestAnimationFrame(() => window.dispatchEvent(new Event('timeline-reveal-playhead')));

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  if (isTextField(el)) return; // 只有打字欄位攔住快捷鍵（滑桿、下拉選單等由 focus.ts 處理）
  const s = useStore.getState();
  const mod = e.ctrlKey || e.metaKey;
  // 對話框開著：編輯器的快捷鍵一律不作用（對話框自己處理 Enter / Esc）。
  // Ctrl+A 只全選使用教學的文字（沒有就什麼都不做，免得瀏覽器全選），Ctrl+C 交給瀏覽器複製
  if (modalOpen()) {
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      const body = document.querySelector('.overlay .tutorial-body');
      if (body) getSelection()?.selectAllChildren(body);
    }
    return;
  }
  const k = e.key.toLowerCase();
  const frame = 1 / fps();
  // 滑鼠在素材預覽上：Space / I / O 給素材預覽
  if (sourceHotkey(e)) return;
  // 最後點的是軌道標籤：Delete 刪選取的軌道
  if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && useTrackSel.getState().focus && useTrackSel.getState().keys.length) {
    e.preventDefault();
    return void deleteTracks(useTrackSel.getState().keys.map(parseRowKey));
  }
  // 最後點的是屬性面板的「作用」列：快捷鍵作用在 Hit 上
  if (hitsFocused()) {
    if (mod && k === 'c') return void (copyHits() && e.preventDefault());
    if (mod && k === 'x') return void (cutHits() && e.preventDefault());
    if (mod && k === 'v') return void (e.preventDefault(), pasteHits());
    if (mod && k === 'd') return void (e.preventDefault(), duplicateHits());
    if ((mod && k === 'b') || (!mod && !e.altKey && k === 's')) return void (e.preventDefault(), splitHit());
    if (mod && k === 'a') return void (e.preventDefault(), selectAllHits());
    if (e.key === 'Delete' || e.key === 'Backspace') return void (e.preventDefault(), deleteSelectedHit());
    // 跟時間軸一樣：Ctrl+← / → 換一個、Ctrl+Home / End 頭尾、Alt+← / → 移動、Home / End 跳到頭尾、Q / W 修剪
    const arrow = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (mod && arrow) return void (e.preventDefault(), navHit(arrow, e.shiftKey));
    if (mod && (e.key === 'Home' || e.key === 'End')) return void (e.preventDefault(), navHitEdge(e.key === 'Home' ? 'first' : 'last', e.shiftKey));
    if (e.altKey && arrow && nudgeHits(arrow * frame * (e.shiftKey ? 10 : 1))) return void e.preventDefault();
    if (!mod && (e.key === 'Home' || e.key === 'End') && hitEdge(e.key === 'Home' ? 'start' : 'end')) return void e.preventDefault();
    if (!mod && !e.altKey && (k === 'q' || k === 'w') && trimHit(k === 'q' ? 'start' : 'end')) return;
  }
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
  // 選取的是轉場：切換 / 多選 / 複製貼上 / 刪除都作用在轉場上
  if (s.selection?.type === 'transition') {
    if (mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); return navTransition(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey); }
    if (mod && (e.key === 'Home' || e.key === 'End')) { e.preventDefault(); return navTransitionEdge(e.key === 'Home' ? 'first' : 'last', e.shiftKey); }
    if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); return navTransitionRow(e.key === 'ArrowUp' ? -1 : 1); }
    if (mod && k === 'a') { e.preventDefault(); return selectAllTransitions(); }
    if (mod && k === 'c') { e.preventDefault(); return void copyTransition(); }
    if (mod && k === 'x') { e.preventDefault(); return cutTransitions(); }
    if (mod && k === 'v') { e.preventDefault(); return void pasteTransition(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return void removeTransitions(); }
  }
  if (mod) {
    // 時間軸：Ctrl+← / → 換片段、加 Shift 延伸選取；Ctrl+Home / End 頭尾；Ctrl+↑ / ↓ 換軌道
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); return navItem(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey); }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); return navEdge(e.key === 'Home' ? 'first' : 'last', e.shiftKey); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); return navRow(e.key === 'ArrowUp' ? -1 : 1); }
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 'c') s.copy();
    else if (k === 'x') s.cut();
    else if (k === 'v') { e.preventDefault(); pasteTimeline(); }
    else if (k === 'd') { e.preventDefault(); duplicateTimeline(); }
    else if (k === 'b') { e.preventDefault(); s.split(); }
    else if (k === 'a') { e.preventDefault(); s.selectAll(); }
    else if (k === 's') { e.preventDefault(); saveNow().then(() => toast($t('已儲存'))); }
    else if (k === 'o') { e.preventDefault(); pickFiles().then(importFiles); }
    else if (k === 'e') { e.preventDefault(); openDialog('export'); }
    else if (k === 'j') { e.preventDefault(); mergeOrHint(); }
    else if (k === 'g') { e.preventDefault(); if (e.shiftKey) s.ungroupSelected(); else if (!s.groupSelected()) toast($t('至少選兩個項目才能建立群組'), 'error'); }
    else if (k === ',') { e.preventDefault(); openDialog('settings'); }
    // Ctrl+Delete / Backspace = 波紋刪除（同 Shift+Delete）
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); s.removeSelection(e.altKey ? 'all' : true); }
    return;
  }
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    return s.nudge((e.key === 'ArrowLeft' ? -1 : 1) * frame * (e.shiftKey ? 10 : 1));
  }
  switch (e.key) {
    case ' ': e.preventDefault(); s.togglePlay(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); s.removeSelection(e.altKey ? 'all' : e.shiftKey); break;
    case 'Home': { e.preventDefault(); const r = selRange(); s.setTime(r ? r.a : 0); revealPlayhead(); break; }
    // 跟 Premiere / DaVinci 一樣停在片段的出點（剪接點上），不是最後一格
    case 'End': { e.preventDefault(); const r = selRange(); s.setTime(r ? r.b : projectDuration(s)); revealPlayhead(); break; }
    case 'ArrowLeft': e.preventDefault(); s.setTime(s.time - (e.shiftKey ? 1 : frame)); break;
    case 'ArrowRight': e.preventDefault(); s.setTime(s.time + (e.shiftKey ? 1 : frame)); break;
    case 'ArrowUp': { e.preventDefault(); const p = editPoints().filter((t) => t < s.time - 1e-3); if (p.length) s.setTime(p[p.length - 1]); break; }
    case 'ArrowDown': { e.preventDefault(); const p = editPoints().find((t) => t > s.time + 1e-3); if (p !== undefined) s.setTime(p); break; }
    case 'Escape': stopPreviewFx(); closeSource(); s.setLoop(null); s.select(null); break;
    case 'F1': e.preventDefault(); openDialog('shortcuts'); break;
    case 'Enter': if (s.selection?.type === 'clip' || s.selection?.type === 'effect' || s.selection?.type === 'transition') { e.preventDefault(); openEditorWindow(); } break;
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
  const editorOpen = useEditorWindow((s) => s.open);
  const hosts = useMemo(() => {
    const h = {} as Record<PanelId, HTMLElement>;
    for (const p of PANELS) {
      const d = document.createElement('div');
      d.className = `panel-host panel-${p.id}`;
      snapToDevicePixels(d);
      h[p.id] = d;
    }
    return h;
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    const warn = (e: BeforeUnloadEvent) => {
      if (useStore.getState().exporting) e.preventDefault();
      // 關掉自動儲存時，有沒存的變更就提醒
      else if (!usePrefs.getState().autosave && useSaveState.getState().state === 'dirty') e.preventDefault();
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

      {L.floating && !editorOpen && (
        <FloatingWindow title={$t('預覽')}>
          <Slot host={hosts.preview} />
        </FloatingWindow>
      )}
      <EditorWindow hosts={hosts} />
      {createPortal(<MediaPanel />, hosts.media)}
      {createPortal(<ColorPanel />, hosts.color)}
      {createPortal(<TextPanel />, hosts.text)}
      {createPortal(<LyricsPanel />, hosts.lyrics)}
      {createPortal(<ModulePanel kind="transition" />, hosts.transition)}
      {createPortal(<ModulePanel kind="effect" />, hosts.effect)}
      {createPortal(<MaskPanel />, hosts.mask)}
      {createPortal(<ModulePanel kind="remap" />, hosts.remap)}
      {createPortal(<InspectorPanel />, hosts.inspector)}
      {createPortal(<CodePanel />, hosts.code)}
      {createPortal(<AiPanel />, hosts.ai)}
      {createPortal(<AutoEditPanel />, hosts.auto)}
      {createPortal(<PreviewPanel />, hosts.preview)}
      {createPortal(<Timeline />, hosts.timeline)}

      <ExportOverlay />
      <Dialogs />
      <ShapeDrawerHost />
      <PickerHost />
      <MenuHost />
      <ConfirmHost />
      <DragGhost />
      <Toasts />
    </div>
  );
}
