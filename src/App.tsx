import { $t, keyLabel, LANGS, lang, saveLang, type Lang } from './i18n';
import { Check, CircleDot, CircleHelp, LoaderCircle } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FORMATS, formatLabel, projectDuration, useStore } from './store';
import { InspectorPanel, MediaPanel, ModulePanel, TextPanel } from './ui/LeftPanel';
import { AnimPanel } from './ui/AnimPanel';
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
import { TabRecHost } from './ui/TabRecord';
import { fps } from './engine/rulerTicks';
import { copyHits, copyKeys, cutHits, deleteSelectedHit, deleteSelectedKey, duplicateHits, hitEdge, hitsFocused, keysFocused, navHit, navHitEdge, nudgeHits, nudgeKeys, pasteHits, pasteKeys, selectAllHits, selectAllKeys, splitHit, trimHit } from './ui/EffectControls';
import { ShapeDrawerHost } from './ui/ShapeDrawer';
import { HELP_GPU, SHORTCUTS, TUTORIAL } from './ui/helpText';
import { useLayout, toast, setBusy, stopPreviewFx, confirmDialog, promptDialog, openMenu, closeMenu, useConfirm, useMenu, type MenuItem } from './ui/uiStore';
import { formatBytes, measureUsage, wipeAllData, type Usage } from './engine/storageUsage';
import { DragNumber } from './ui/DragNumber';
import { OVERLAY_DEFAULT, usePrefs, type OverlayColors } from './prefs';
import { Eye, Film, Folder, Globe, Keyboard, Languages, Palette, Search, Settings, X } from 'lucide-react';
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
/** 說明視窗打開時要捲到、標出來的那一段（使用教學裡的一條） */
let helpItem: string | null = null;
/** 打開使用教學、直接跳到這一段（設定、介面上的問號連過來） */
const openHelp = (item: string) => { helpItem = item; setDialogGlobal(null); setTimeout(() => setDialogGlobal('tutorial')); };

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

/** 「Ctrl+Shift+G / Ctrl+G」→ 一顆一顆的按鍵 */
function Keys({ k }: { k: string }) {
  const alts = k.split(/\s*[\/、]\s*/).filter(Boolean);
  return (
    <span className="help-keys">
      {alts.map((alt, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="help-or">/</span>}
          {alt.split(/\+(?=.)/).map((part, j) => <kbd key={j}>{keyLabel(part)}</kbd>)}
        </Fragment>
      ))}
    </span>
  );
}

/** 搜尋字標出來 */
function Hl({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lo = text.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  for (let j = lo.indexOf(q); j >= 0; j = lo.indexOf(q, i)) {
    if (j > i) out.push(text.slice(i, j));
    out.push(<mark key={j}>{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  out.push(text.slice(i));
  return <>{out}</>;
}

const KEYS_SEC = -1;

/** 說明視窗：左邊章節、右邊內容，上方搜尋（教學和快捷鍵一起找） */
function HelpDialog({ close, start }: { close: () => void; start: 'tutorial' | 'shortcuts' }) {
  // 從別的地方連過來：開在那一段所在的章節，捲到那一段、亮一下
  const [target] = useState(() => { const t = helpItem; helpItem = null; return t; });
  const [sec, setSec] = useState(() => {
    if (start === 'shortcuts') return KEYS_SEC;
    const i = target ? TUTORIAL.findIndex((s) => s.items.includes(target)) : -1;
    return i < 0 ? 0 : i;
  });
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!target) searchRef.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const li = target && !q ? bodyRef.current?.querySelector<HTMLElement>('li.help-target') : null;
    if (li) li.scrollIntoView({ block: 'center' });
    else bodyRef.current?.scrollTo({ top: 0 });
  }, [sec, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const hits = q
    ? {
        tut: TUTORIAL.map((s) => ({ title: s.title, items: s.items.filter((it) => it.toLowerCase().includes(q) || s.title.toLowerCase().includes(q)) })).filter((s) => s.items.length),
        keys: SHORTCUTS.filter(([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q)),
      }
    : null;
  const keyList = (list: [string, string][]) => (
    <div className="help-keys-list">
      {list.map(([k, v]) => (
        <div key={k + v} className="help-key-row"><Keys k={k} /><span><Hl text={v} q={q} /></span></div>
      ))}
    </div>
  );

  return (
    <div className="dialog help-win">
      <div className="help-head">
        <h3>{$t('說明')}</h3>
        <label className="lib-search help-search">
          <Search size={13} />
          <input ref={searchRef} value={query} placeholder={$t('搜尋…')} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && query && (e.stopPropagation(), setQuery(''))} />
          {query && <button onClick={() => setQuery('')}><X size={11} /></button>}
        </label>
        <button className="ec-icon" title={$t('關閉')} onClick={close}><X size={15} /></button>
      </div>
      <div className="help-main">
        <nav className="help-nav">
          {TUTORIAL.map((s, i) => (
            <button key={s.title} className={!q && sec === i ? 'on' : ''} onClick={() => { setQuery(''); setSec(i); }}>{s.title}</button>
          ))}
          <div className="help-nav-sep" />
          <button className={!q && sec === KEYS_SEC ? 'on' : ''} onClick={() => { setQuery(''); setSec(KEYS_SEC); }}><Keyboard size={13} /> {$t('快捷鍵')}</button>
        </nav>
        <div ref={bodyRef} className="help-body">
          {hits ? (
            hits.tut.length || hits.keys.length ? (
              <>
                {hits.tut.map((s) => (
                  <section key={s.title}>
                    <h4>{s.title}</h4>
                    <ul>{s.items.map((it) => <li key={it}><Hl text={it} q={q} /></li>)}</ul>
                  </section>
                ))}
                {hits.keys.length > 0 && (
                  <section>
                    <h4>{$t('快捷鍵')}</h4>
                    {keyList(hits.keys)}
                  </section>
                )}
              </>
            ) : (
              <p className="help-empty muted">{$t('找不到符合的說明')}</p>
            )
          ) : sec === KEYS_SEC ? (
            <section>
              <h4>{$t('快捷鍵')}</h4>
              {keyList(SHORTCUTS)}
            </section>
          ) : (
            <section>
              <h4>{TUTORIAL[sec].title}</h4>
              <ul>{TUTORIAL[sec].items.map((it) => <li key={it} className={it === target ? 'help-target' : undefined}>{it}</li>)}</ul>
            </section>
          )}
        </div>
      </div>
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
/** help = 使用教學裡的一段：名稱可以點（游標變問號），打開說明跳到那裡 */
function SetRow({ label, desc, inline, help, children }: { label: ReactNode; desc: ReactNode; inline?: boolean; help?: string; children: ReactNode }) {
  return (
    <div className={`set-row ${inline ? 'inline' : ''}`}>
      <div className="set-text">
        {help
          ? <button type="button" className="set-name set-help" title={$t('說明')} onClick={() => openHelp(help)}>{label}<CircleHelp size={12} /></button>
          : <div className="set-name">{label}</div>}
        <div className="set-desc">{desc}</div>
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  );
}

/** 設定 → 專案 → 儲存空間：各項用量，清除全部要確認兩次（第二次要打字） */
/** 瀏覽器實際用的顯示卡（WebGL 回報的名稱；拿不到 = null） */
function gpuName(): string | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const raw = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    if (!raw) return null;
    // Chrome：ANGLE (廠商, 型號 (0x…) Direct3D11 …) → 只留型號
    const m = /^ANGLE \([^,]*,\s*(.+?)(?:\s*\(0x[0-9A-Fa-f]+\))?(?:\s+Direct3D.*|\s+OpenGL.*|\s+Vulkan.*)?\)?$/.exec(raw);
    // Mac：ANGLE Metal Renderer: Apple M1, Unspecified Version
    return (m?.[1] ?? raw).replace(/^ANGLE Metal Renderer:\s*/, '').replace(/,\s*Unspecified Version$/, '').trim();
  } catch {
    return null;
  }
}

/** 設定 → 預覽：目前用的顯示卡、匯出能不能用硬體編碼 */
function GpuInfo() {
  const [hw, setHw] = useState<boolean | null>(null);
  const name = useMemo(gpuName, []);
  useEffect(() => {
    if (typeof VideoEncoder === 'undefined') return void setHw(false);
    VideoEncoder.isConfigSupported({ codec: 'avc1.640033', width: 1920, height: 1080, bitrate: 20_000_000, framerate: 30, hardwareAcceleration: 'prefer-hardware' })
      .then((r) => setHw(!!r.supported), () => setHw(false));
  }, []);
  // 內顯（筆電常見：有獨立顯卡但瀏覽器跑在內顯上）
  const integrated = !!name && /intel|uhd|iris|radeon\(tm\) graphics|vega \d+ graphics/i.test(name);
  return (
    <span className="set-hint gpu-info">
      {name ?? $t('不明')}{integrated && $t('（內顯）')}
      {hw !== null && <> · {hw ? $t('硬體編碼') : $t('軟體編碼')}</>}
    </span>
  );
}

function StorageUsage() {
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => { let live = true; void measureUsage().then((r) => live && setU(r)); return () => { live = false; }; }, []);
  const wipe = async () => {
    if (!await confirmDialog({ title: $t('清除所有資料？'), message: $t('專案、素材、自訂的模組 / 形狀 / 風格、快取和設定都會刪除，無法復原。'), ok: $t('繼續'), danger: true })) return;
    const word = $t('全部刪除');
    const v = await promptDialog({ title: $t('再確認一次'), message: $t('輸入「{0}」來確認', word), value: '', ok: $t('清除') });
    if (v === null) return;
    if (v.trim() !== word) return void toast($t('輸入的字不一致，沒有刪除'), 'error');
    await wipeAllData();
  };
  // 長條的尺度 = 最大那項再多 25%（最大的也不會整條滿）；至少 1 MB，清空後幾百 KB 才不會佔一大段
  const max = Math.max(1024 * 1024, 1.25 * Math.max(0, ...(u?.parts.map((p) => p.bytes) ?? [0])));
  return (
    <div className="storage">
      {!u ? <span className="set-hint">{$t('計算中…')}</span> : (
        <>
          <div className="storage-total">
            <b>{formatBytes(u.used ?? u.parts.reduce((s, p) => s + p.bytes, 0))}</b>
            {u.quota !== null && <span className="set-hint">/ {$t('上限 {0}', formatBytes(u.quota))}</span>}
          </div>
          <div className="storage-list">
            {u.parts.map((p) => (
              <div key={p.label} className="storage-row">
                <span>{p.label}</span>
                <i><b style={{ width: `${(p.bytes / max) * 100}%` }} /></i>
                <span className="set-hint">{formatBytes(p.bytes)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <button className="btn danger-fill small" onClick={() => void wipe()}>{$t('清除所有資料…')}</button>
    </div>
  );
}

const OVERLAY_KEYS: [keyof OverlayColors, string][] = [
  ['mask', $t('遮罩')], ['maskInv', $t('反轉遮罩')], ['track', $t('追蹤')], ['param', $t('特效參數')], ['clip', $t('片段變換')],
];

function SettingsDialog({ close }: { close: () => void }) {
  const L = useLayout();
  const P = usePrefs();
  const fmt = useStore((s) => s.format);
  // 設定是即時套用的：打開時記下來，取消時還原
  const [orig] = useState(() => {
    const l = useLayout.getState(), p = usePrefs.getState();
    return {
      layout: { previewScale: l.previewScale, upperLayerAt: l.upperLayerAt, wheelScroll: l.wheelScroll, trackSize: l.trackSize, beatLead: l.beatLead, timeGrid: l.timeGrid },
      prefs: { stillDur: p.stillDur, transDur: p.transDur, autosave: p.autosave, proxy: p.proxy, proxyQuality: p.proxyQuality, theme: p.theme, overlay: p.overlay },
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
  type Row = { label: string; desc: string; inline?: boolean; help?: string; ctl: ReactNode };
  const secs: { title: string; icon: ReactNode; rows: Row[] }[] = [
    { title: $t('專案'), icon: <Folder size={13} />, rows: [
      { label: $t('輸出比例'), desc: `${$t('匯出與預覽的畫面比例')} · ${fmt.w} × ${fmt.h}`, ctl: (
        <Seg className="wrap" value={FORMATS.find((f) => fmt.w === f.w && fmt.h === f.h)?.id ?? ''} on={(id) => { const f = FORMATS.find((x) => x.id === id); if (f) useStore.getState().setFormat(f); }}
          opts={FORMATS.map((f) => ({ v: f.id, title: `${f.w} × ${f.h}`, label: <><span className="ratio-box" style={{ aspectRatio: `${f.w} / ${f.h}` }} />{f.label}</> }))} />
      ) },
      { label: $t('自動儲存'), desc: $t('關閉後按 Ctrl+S 存檔'), inline: true, ctl: <Switch v={P.autosave} on={(v) => P.set({ autosave: v })} /> },
      { label: $t('儲存空間'), desc: $t('這個網站在瀏覽器裡用掉的空間'), ctl: <StorageUsage /> },
    ] },
    { title: $t('預覽'), icon: <Eye size={13} />, rows: [
      { label: $t('預覽畫質'), desc: $t('調低編輯會比較順，不影響匯出'), ctl: <Seg value={L.previewScale} on={(q) => L.set({ previewScale: q })} opts={QUALITIES.map((q) => ({ v: q, label: q === 1 ? $t('完整') : `${Math.round(q * 100)}%` }))} /> },
      { label: $t('顯示卡'), desc: $t('預覽與匯出用的顯示卡'), help: HELP_GPU, ctl: <GpuInfo /> },
      { label: $t('預覽代理檔'), desc: $t('關鍵影格很稀的影片，預覽改用小副本，不影響匯出'), inline: true, ctl: <Switch v={P.proxy} on={(v) => P.set({ proxy: v })} /> },
      ...(P.proxy ? [{ label: $t('代理檔畫質'), desc: $t('越低檔案越小，換了會重新產生'), ctl: <Seg value={P.proxyQuality} on={(q) => P.set({ proxyQuality: q })} opts={[{ v: 'low' as const, label: $t('省空間') }, { v: 'medium' as const, label: $t('標準') }, { v: 'high' as const, label: $t('清晰') }]} /> }] : []),
    ] },
    { title: $t('時間軸'), icon: <Film size={13} />, rows: [
      { label: $t('上層軌道顯示在'), desc: $t('疊在上面的軌道放在時間軸的哪一邊'), ctl: <Seg value={L.upperLayerAt} on={(v) => L.set({ upperLayerAt: v })} opts={[{ v: 'bottom' as const, label: $t('下方') }, { v: 'top' as const, label: $t('上方') }]} /> },
      { label: $t('軌道高度'), desc: $t('預設與新增的軌道'), ctl: <Seg value={L.trackSize} on={(k) => L.set({ trackSize: k })} opts={[{ v: 's' as const, label: $t('小') }, { v: 'm' as const, label: $t('中') }, { v: 'l' as const, label: $t('大') }]} /> },
      { label: $t('滾輪捲動方向'), desc: $t('在時間軸上直接滾動滾輪時'), ctl: <Seg value={L.wheelScroll === 'vertical' ? 'vertical' : 'horizontal'} on={(v) => L.set({ wheelScroll: v })} opts={[{ v: 'horizontal' as const, label: $t('水平') }, { v: 'vertical' as const, label: $t('垂直') }]} /> },
      { label: $t('圖片 / 色板 / 文字預設長度'), desc: $t('新加入時的長度'), inline: true, ctl: <DragNumber value={P.stillDur} min={0.1} max={60} step={0.1} def={2} suffix=" s" onChange={(v) => P.set({ stillDur: Math.round(v * 100) / 100 })} /> },
      { label: $t('轉場預設長度'), desc: $t('新加入轉場時的長度'), inline: true, ctl: <DragNumber value={P.transDur} min={0.05} max={5} step={0.05} def={0.4} suffix=" s" onChange={(v) => P.set({ transDur: Math.round(v * 100) / 100 })} /> },
      { label: $t('時間軸格線'), desc: $t('拖曳、吸附、節拍的最小單位'), ctl: <Seg value={L.timeGrid} on={(n) => L.set({ timeGrid: n })} opts={([30, 60] as const).map((n) => ({ v: n, label: `1/${n} s` }))} /> },
      { label: $t('節拍提前'), desc: $t('節拍格線比聲音早一點，看起來才會對拍'), inline: true, ctl: (
        <>
          <span className="set-hint">≈ {Math.round((L.beatLead / 60) * 1000)} ms</span>
          <DragNumber value={L.beatLead} min={0} max={30} step={1} decimals={0} def={4} suffix=" / 60 s" onChange={(v) => L.set({ beatLead: Math.round(v) })} />
        </>
      ) },
    ] },
    { title: $t('外觀'), icon: <Palette size={13} />, rows: [
      { label: $t('主題'), desc: $t('介面的深淺'), ctl: <Seg value={P.theme} on={(v) => P.set({ theme: v })} opts={[{ v: 'dark' as const, label: $t('深色') }, { v: 'light' as const, label: $t('淺色') }, { v: 'system' as const, label: $t('跟隨系統') }]} /> },
      { label: $t('預覽框顏色'), desc: $t('疊在預覽畫面上的框'), ctl: (
        <div className="ov-colors">
          {OVERLAY_KEYS.map(([k, label]) => (
            <label key={k} className="ov-color">
              <input type="color" className="color" value={(P.overlay ?? OVERLAY_DEFAULT)[k]} onChange={(e) => P.set({ overlay: { ...OVERLAY_DEFAULT, ...P.overlay, [k]: e.target.value } })} />
              {label}
            </label>
          ))}
          <button className="btn small" disabled={OVERLAY_KEYS.every(([k]) => (P.overlay ?? OVERLAY_DEFAULT)[k] === OVERLAY_DEFAULT[k])} onClick={() => P.set({ overlay: OVERLAY_DEFAULT })}>{$t('重設')}</button>
        </div>
      ) },
    ] },
    { title: `${$t('語言')} / Language`, icon: <Languages size={13} />, rows: [
      { label: $t('介面語言'), desc: $t('切換後會重新載入'), ctl: <Seg value={lang} on={changeLanguage} opts={LANGS.map((l) => ({ v: l.id, label: l.label }))} /> },
    ] },
  ];
  const [sec, setSec] = useState(0);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [sec, q]);
  const shown = q
    ? secs.map((s) => ({ ...s, rows: s.rows.filter((r) => `${s.title} ${r.label} ${r.desc}`.toLowerCase().includes(q)) })).filter((s) => s.rows.length)
    : [secs[sec]];
  return (
    <div className="dialog help-win settings-win">
      <div className="help-head">
        <h3>{$t('設定')}</h3>
        <label className="lib-search help-search">
          <Search size={13} />
          <input ref={searchRef} value={query} placeholder={$t('搜尋…')} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && query && (e.stopPropagation(), setQuery(''))} />
          {query && <button onClick={() => setQuery('')}><X size={11} /></button>}
        </label>
      </div>
      <div className="help-main">
        <nav className="help-nav">
          {secs.map((s, i) => (
            <button key={s.title} className={!q && sec === i ? 'on' : ''} onClick={() => { setQuery(''); setSec(i); }}>{s.icon} {s.title}</button>
          ))}
        </nav>
        <div ref={bodyRef} className="help-body set-body">
          {shown.length ? shown.map((s) => (
            <section key={s.title}>
              <h4>{s.title}</h4>
              {s.rows.map((r) => (
                <SetRow key={r.label} label={<Hl text={r.label} q={q} />} desc={<Hl text={r.desc} q={q} />} inline={r.inline} help={r.help}>{r.ctl}</SetRow>
              ))}
            </section>
          )) : <p className="help-empty muted">{$t('找不到符合的設定')}</p>}
        </div>
      </div>
      <div className="dialog-actions help-foot">
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
      {(d === 'shortcuts' || d === 'tutorial') && <HelpDialog key={d} close={close} start={d} />}
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

/** 剩下的秒數 → 1:05 / 1:02:03 */
const fmtEta = (sec: number) => {
  const s = Math.max(0, Math.round(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

function ExportOverlay() {
  const ex = useStore((s) => s.exporting);
  if (!ex) return null;
  return (
    <div className="overlay export-overlay">
      <div className="dialog">
        <h3>{$t('匯出中…')}{' '}{(ex.progress * 100).toFixed(0)}%</h3>
        <div className="bar"><div style={{ width: `${ex.progress * 100}%` }} /></div>
        <div className="muted export-eta">{ex.cancel ? $t('取消中…') : ex.prep ? $t('準備中…') : ex.eta !== undefined ? $t('剩下約 {0}', fmtEta(ex.eta)) : $t('估算剩餘時間…')}</div>
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
        { label: $t('匯入專案包…'), action: async () => { const [file] = await pickFiles('.ybeat', false); if (!file) return; if (!await confirmDialog({ title: $t('匯入專案包？'), message: $t('目前專案會被取代，請先匯出專案包備份。'), ok: $t('匯入') })) return; try { await importProjectPack(file, (n, total) => setBusy($t('匯入專案包 {0}/{1}', n, total), n / Math.max(1, total))); toast($t('專案包已匯入')); } catch (e) { toast($t('匯入失敗：{0}', e instanceof Error ? e.message : e), 'error'); } finally { setBusy(null); } } },
        { label: $t('匯出專案包…'), action: async () => { try { downloadBlob(await exportProjectPack((n, total) => setBusy($t('匯出專案包 {0}/{1}', n, total), n / Math.max(1, total))), 'YBeat_project.ybeat'); toast($t('專案包已匯出')); } catch (e) { toast($t('匯出失敗：{0}', e instanceof Error ? e.message : e), 'error'); } finally { setBusy(null); } } },
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

/** ↑ / ↓ 停的點：所有軌道上每個項目（影片 / 圖片 / 文字片段、音訊、特效方塊、動畫）的頭尾 */
function editPoints() {
  const s = useStore.getState();
  const pts = new Set<number>([0]);
  for (const c of [...s.clips, ...s.audios, ...s.effects, ...s.anims]) {
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

const REPEATABLE = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '=', '+', '-']);

/** 編輯視窗開著時還能用的快捷鍵（關鍵影格 / 作用列的快捷鍵另外處理） */
function editorKeyOk(e: KeyboardEvent, mod: boolean, k: string) {
  if (keysFocused() || hitsFocused()) return true;
  if (mod) return k === 'z' || k === 'y' || k === 's';
  if (e.altKey) return false;
  return [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'F1', 'Escape'].includes(e.key);
}

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
      const body = document.querySelector('.overlay .help-body:not(.set-body)');
      if (body) getSelection()?.selectAllChildren(body);
    }
    return;
  }
  const k = e.key.toLowerCase();
  // 右鍵選單 / 選單列開著：Esc 交給選單（只關選單，不取消選取）；其他快捷鍵先關掉選單再照常作用
  if (useMenu.getState().menu) {
    if (e.key === 'Escape') return;
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) closeMenu();
  }
  // 按住不放：只有移動類（方向鍵、縮放、復原 / 重做）重複；其他是一次性的動作（N / Space 不會一直來回切、M 不會疊一堆標記）
  if (e.repeat && !REPEATABLE.has(e.key) && !(mod && (k === 'z' || k === 'y'))) {
    if (e.key === ' ') e.preventDefault();
    return;
  }
  // 編輯視窗開著：只留播放、移動播放頭、復原 / 存檔這類；分割、刪除、貼上等改時間軸結構的不作用（會改到正在編輯的片段）
  if (useEditorWindow.getState().open && !editorKeyOk(e, mod, k)) return;
  const frame = 1 / fps();
  // 有選取文字（例如程式碼的錯誤訊息）：Ctrl+C 交給瀏覽器複製文字
  if (mod && k === 'c' && getSelection()?.toString()) return;
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
    if (e.shiftKey && k === 'm') {
      e.preventDefault();
      const next = s.markers.find((m) => m.t > s.time + 1e-3);
      if (next) { s.setTime(next.t); revealPlayhead(); }
      return;
    }
    // 時間軸：Ctrl+← / → 換片段、加 Shift 延伸選取；Ctrl+Home / End 頭尾；Ctrl+↑ / ↓ 換軌道
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); return navItem(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey); }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); return navEdge(e.key === 'Home' ? 'first' : 'last', e.shiftKey); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); return navRow(e.key === 'ArrowUp' ? -1 : 1); }
    // Ctrl+Shift+字母：只有 Ctrl+Shift+Z（重做）、Ctrl+Shift+G（解除群組）有定義，其他不要當成 Ctrl+字母
    if (e.shiftKey && k !== 'z' && k !== 'g' && e.key !== 'Delete' && e.key !== 'Backspace') return;
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
    else if (k === 'l') { e.preventDefault(); s.toggleLockSelected(); }
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
    case 'Enter': if (s.selection?.type === 'clip' || s.selection?.type === 'effect' || s.selection?.type === 'transition' || s.selection?.type === 'anim') { e.preventDefault(); openEditorWindow(); } break;
    case '=': case '+': s.setPps(s.pps * 1.25); break;
    case '-': s.setPps(s.pps / 1.25); break;
    case '\\': window.dispatchEvent(new Event('timeline-fit')); break;
    default:
      if (k === 'm') {
        e.preventDefault();
        if (e.shiftKey) {
          const previous = s.markers.filter((m) => m.t < s.time - 1e-3);
          if (previous.length) { s.setTime(previous[previous.length - 1].t); revealPlayhead(); }
        } else s.addMarker(s.time);
      }
      // 單鍵：加 Shift / Alt 不算（Shift+M 上面另外處理）
      else if (e.shiftKey || e.altKey) return;
      else if (k === 's') s.split();
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
        <button className="title-icon" title={$t('設定') + keyLabel(' (Ctrl+,)')} onClick={() => openDialog('settings')}>
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
      {createPortal(<AnimPanel />, hosts.anim)}
      {createPortal(<InspectorPanel />, hosts.inspector)}
      {createPortal(<CodePanel />, hosts.code)}
      {createPortal(<AiPanel />, hosts.ai)}
      {createPortal(<AutoEditPanel />, hosts.auto)}
      {createPortal(<PreviewPanel />, hosts.preview)}
      {createPortal(<Timeline />, hosts.timeline)}

      <ExportOverlay />
      <TabRecHost />
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
