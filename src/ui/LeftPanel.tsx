import React, { useMemo, useState } from 'react';
import { mediaUsable, useStore, type Clip, type FxItem, type Media, type ModuleKind } from '../store';
import type { Module } from '../modules/builtin';
import { importFiles, pickFiles, relinkWithPicker, removeMedia } from '../engine/media';
import { parseParams, type ParamDef, type ParamValue, type ParamValues } from '../engine/params';
import { computeFrame, transitionWindow, sortClips, makeCtx } from '../engine/renderer';
import { DEFAULT_TRANSFORM, FITS, type Fit } from '../engine/transform';
import { plainSpeed } from '../engine/remap';
import { useModuleThumb } from '../engine/thumbs';
import { startLibraryDrag } from './dnd';
import { openMenu, stopPreviewFx, useLayout, usePreviewFx, type MenuItem } from './uiStore';
import { DragNumber } from './DragNumber';
import { ModuleCode } from './ModuleCode';
import { EffectControls, clipChannels, clipHost, fxChannels, fxHost, type Section } from './EffectControls';

// ───────────────────────── 共用：搜尋 + 檢視切換 ─────────────────────────

function LibToolbar({ id, query, setQuery, children }: { id: string; query: string; setQuery: (q: string) => void; children?: React.ReactNode }) {
  const view = useLayout((s) => s.libView[id] ?? 'grid');
  const setView = (v: 'list' | 'grid') => useLayout.getState().set({ libView: { ...useLayout.getState().libView, [id]: v } });
  return (
    <div className="lib-bar">
      <div className="lib-search">
        <span>⌕</span>
        <input placeholder="搜尋…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
        {query && <button onClick={() => setQuery('')}>✕</button>}
      </div>
      {children}
      <div className="lib-view">
        <button className={view === 'list' ? 'on' : ''} title="清單" onClick={() => setView('list')}>☰</button>
        <button className={view === 'grid' ? 'on' : ''} title="格狀" onClick={() => setView('grid')}>▦</button>
      </div>
    </div>
  );
}

const match = (name: string, q: string) => !q || name.toLowerCase().includes(q.trim().toLowerCase());

// ───────────────────────── 素材 ─────────────────────────

const KIND_LABEL = { video: '影片', image: '圖片', audio: '音訊' } as const;

export function MediaPanel() {
  const media = useStore((s) => s.media);
  const clips = useStore((s) => s.clips);
  const audios = useStore((s) => s.audios);
  const addClip = useStore((s) => s.addClip);
  const view = useLayout((s) => s.libView.media ?? 'grid');
  const filter = useLayout((s) => s.mediaFilter);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'added' | 'name' | 'type'>('added');

  const uses = (id: string) => clips.filter((c) => c.mediaId === id).length + audios.filter((a) => a.mediaId === id).length;
  const list = useMemo(() => {
    const l = media.filter((m) => (filter === 'all' || m.kind === filter) && match(m.name, q));
    if (sort === 'name') l.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'type') l.sort((a, b) => a.kind.localeCompare(b.kind));
    return l;
  }, [media, filter, q, sort]);
  const missing = media.filter((m) => m.missing).length;

  const itemMenu = (e: React.MouseEvent, m: Media) => {
    e.preventDefault();
    e.stopPropagation();
    const n = uses(m.id);
    openMenu(e.clientX, e.clientY, [
      { label: '加到時間軸結尾', action: mediaUsable(m) ? () => addClip(m.id) : undefined },
      { label: m.missing ? '重新連結檔案…' : '替換檔案…', action: () => relinkWithPicker(m.id) },
      { separator: true },
      { label: n ? `從素材庫移除（${n} 個片段使用中）` : '從素材庫移除', action: () => removeMedia(m.id), danger: true },
    ]);
  };

  const bgMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const L = useLayout.getState();
    const unused = media.filter((m) => !uses(m.id));
    const items: MenuItem[] = [
      { label: '匯入媒體…', shortcut: 'Ctrl+O', action: async () => importFiles(await pickFiles()) },
      { separator: true },
      { label: '清單檢視', checked: view === 'list', action: () => L.set({ libView: { ...L.libView, media: 'list' } }) },
      { label: '格狀檢視', checked: view === 'grid', action: () => L.set({ libView: { ...L.libView, media: 'grid' } }) },
      { separator: true },
      { label: '依加入順序', checked: sort === 'added', action: () => setSort('added') },
      { label: '依名稱排序', checked: sort === 'name', action: () => setSort('name') },
      { label: '依類型排序', checked: sort === 'type', action: () => setSort('type') },
      { separator: true },
      { label: `移除未使用的素材（${unused.length}）`, danger: true, action: unused.length ? () => unused.forEach((m) => removeMedia(m.id)) : undefined },
    ];
    openMenu(e.clientX, e.clientY, items);
  };

  return (
    <div className="lib" onContextMenu={bgMenu}>
      <LibToolbar id="media" query={q} setQuery={setQ}>
        <button className="lib-add" title="匯入媒體 (Ctrl+O)" onClick={async () => importFiles(await pickFiles())}>＋</button>
      </LibToolbar>
      <div className="lib-filter">
        {(['all', 'video', 'image', 'audio'] as const).map((f) => (
          <button key={f} className={filter === f ? 'on' : ''} onClick={() => useLayout.getState().set({ mediaFilter: f })}>
            {f === 'all' ? '全部' : KIND_LABEL[f]}
            <span>{f === 'all' ? media.length : media.filter((m) => m.kind === f).length}</span>
          </button>
        ))}
      </div>
      <div className="lib-body">
        {missing > 0 && <div className="warn">⚠ {missing} 個素材遺失：點它重新選檔，或把新素材拖到時間軸上的紅色片段。</div>}
        {media.length === 0 && (
          <div className="lib-empty">
            <button className="btn primary" onClick={async () => importFiles(await pickFiles())}>＋ 匯入影片 / 圖片 / 音樂</button>
            <p className="muted small">也可以把檔案拖進視窗任何地方</p>
          </div>
        )}
        {media.length > 0 && list.length === 0 && <p className="muted small center">沒有符合的素材</p>}
        <div className={view === 'grid' ? 'lib-grid' : 'lib-list'}>
          {list.map((m) => (
            <div
              key={m.id}
              className={`lib-item ${m.missing ? 'missing' : ''}`}
              onPointerDown={(e) => mediaUsable(m) && startLibraryDrag(e, { kind: 'media', id: m.id }, m.name, m.kind === 'audio' ? undefined : m.thumb)}
              onClick={() => m.missing && relinkWithPicker(m.id)}
              onDoubleClick={() => mediaUsable(m) && addClip(m.id)}
              onContextMenu={(e) => itemMenu(e, m)}
              title={m.missing ? `${m.name}（遺失，點擊重新連結）` : m.name}
            >
              <div className={`lib-thumb ${m.kind}`} style={m.thumb ? { backgroundImage: `url(${m.thumb})` } : undefined}>
                {m.kind === 'audio' && <span className="note">♪</span>}
                {m.missing && <span className="miss">⚠ 遺失</span>}
                {view === 'grid' && m.kind !== 'image' && <span className="dur">{m.duration.toFixed(1)}s</span>}
                {uses(m.id) > 0 && view === 'grid' && <span className="used" title="已在時間軸上使用">●</span>}
              </div>
              <div className="lib-meta">
                <div className="lib-name">{m.name}</div>
                {view === 'list' && (
                  <div className="lib-sub">{KIND_LABEL[m.kind]}{m.kind !== 'image' ? ` · ${m.duration.toFixed(1)}s` : ` · ${m.width}×${m.height}`}{uses(m.id) ? ` · 使用 ${uses(m.id)} 次` : ''}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── 轉場 / 特效 / 變速 ─────────────────────────

function ModuleThumb({ m }: { m: Module }) {
  const url = useModuleThumb(m);
  return <div className="lib-thumb mod" style={url ? { backgroundImage: `url(${url})` } : undefined}>{!url && <span className="loading" />}</div>;
}

export function ModulePanel({ kind }: { kind: ModuleKind }) {
  const all = useStore((s) => s.modules);
  const previewing = usePreviewFx((s) => s.fx?.moduleId);
  const view = useLayout((s) => s.libView[kind] ?? 'grid');
  const [q, setQ] = useState('');
  const [onlyCustom, setOnlyCustom] = useState(false);
  const { select, createModule } = useStore.getState();
  const modules = all.filter((m) => m.kind === kind && match(m.name, q) && (!onlyCustom || !m.builtin));

  const apply = (id: string) => {
    const s = useStore.getState();
    stopPreviewFx();
    if (kind === 'effect') return s.addEffect(id, s.time, 0);
    let clipId = s.selection?.type === 'clip' || s.selection?.type === 'transition' ? s.selection.id : null;
    if (!clipId) {
      const ctx = makeCtx(s);
      for (let i = ctx.videoTracks.length - 1; i >= 0 && !clipId; i--) {
        const fr = computeFrame(ctx.videoTracks[i], s.time);
        clipId = fr.kind === 'clip' ? fr.clip.id : fr.kind === 'transition' ? fr.B.id : null;
      }
    }
    if (!clipId) return;
    if (kind === 'transition') s.setTransition(clipId, id);
    else s.setRemap(clipId, id);
  };

  const togglePreview = (id: string) => {
    if (kind === 'remap') return;
    useStore.getState().setPlaying(false);
    usePreviewFx.setState({ fx: previewing === id ? null : { moduleId: id, t0: performance.now() } });
  };

  const itemMenu = (e: React.MouseEvent, m: Module) => {
    e.preventDefault();
    e.stopPropagation();
    const S = useStore.getState();
    openMenu(e.clientX, e.clientY, [
      { label: kind === 'effect' ? '在播放頭加入' : '套用到選取的片段', action: () => apply(m.id) },
      { label: '在預覽中試看', action: kind !== 'remap' ? () => togglePreview(m.id) : undefined },
      { label: '編輯程式碼', action: () => { stopPreviewFx(); select({ type: 'module', id: m.id }); } },
      { label: '複製為新模組', action: () => select({ type: 'module', id: S.forkModule(m.id) }) },
      { separator: true },
      { label: '重置為預設', action: m.builtin ? () => S.resetModule(m.id) : undefined },
      { label: '刪除模組', danger: true, action: !m.builtin ? () => { S.select({ type: 'module', id: m.id }); S.removeSelection(); } : undefined },
    ]);
  };

  const bgMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const L = useLayout.getState();
    openMenu(e.clientX, e.clientY, [
      { label: '新增自訂模組', action: () => createModule(kind) },
      { separator: true },
      { label: '清單檢視', checked: view === 'list', action: () => L.set({ libView: { ...L.libView, [kind]: 'list' } }) },
      { label: '格狀檢視', checked: view === 'grid', action: () => L.set({ libView: { ...L.libView, [kind]: 'grid' } }) },
      { separator: true },
      { label: '只顯示自訂模組', checked: onlyCustom, action: () => setOnlyCustom(!onlyCustom) },
      { label: '結束預覽', action: previewing ? stopPreviewFx : undefined },
    ]);
  };

  const hint = kind === 'remap' ? '拖到影片片段上套用' : '點一下試看 · 拖曳或雙擊套用';

  return (
    <div className="lib" onContextMenu={bgMenu}>
      <LibToolbar id={kind} query={q} setQuery={setQ}>
        <button className="lib-add" title="新增自訂模組" onClick={() => createModule(kind)}>＋</button>
      </LibToolbar>
      <div className="lib-body">
        <p className="muted small lib-hint">{hint}</p>
        {modules.length === 0 && <p className="muted small center">沒有符合的模組</p>}
        <div className={view === 'grid' ? 'lib-grid mods' : 'lib-list'}>
          {modules.map((m) => (
            <div
              key={m.id}
              className={`lib-item mod mk-${kind} ${previewing === m.id ? 'previewing' : ''}`}
              onPointerDown={(e) => startLibraryDrag(e, { kind: 'module', id: m.id, moduleKind: kind }, m.name)}
              onClick={() => togglePreview(m.id)}
              onDoubleClick={() => apply(m.id)}
              onContextMenu={(e) => itemMenu(e, m)}
              title={m.name}
            >
              <ModuleThumb m={m} />
              <div className="lib-meta">
                <div className="lib-name">{previewing === m.id ? '▶ ' : ''}{m.name}</div>
                {view === 'list' && !m.builtin && <div className="lib-sub">自訂</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── 屬性（效果控制） ─────────────────────────

export function InspectorPanel() {
  const sel = useStore((s) => s.selection);
  return (
    <div className="inspector-panel">
      {!sel && <div className="empty">在時間軸上選取片段、轉場或特效</div>}
      {sel?.type === 'clip' && <ClipInspector id={sel.id} />}
      {sel?.type === 'transition' && <TransitionInspector clipId={sel.id} />}
      {sel?.type === 'effect' && <EffectInspector id={sel.id} />}
      {sel?.type === 'audio' && <AudioInspector id={sel.id} />}
      {sel?.type === 'module' && <ModuleInspector id={sel.id} />}
    </div>
  );
}

function Title({ kind, label, name }: { kind: string; label: string; name: string }) {
  return (
    <span className="ec-title">
      <span className={`kind ${kind}`}>{label}</span>
      <span className="ec-name" title={name}>{name}</span>
    </span>
  );
}

function ModuleSelect({ kind, value, onChange, allowNone }: { kind: ModuleKind; value: string | null; onChange: (id: string | null) => void; allowNone?: boolean }) {
  const modules = useStore((s) => s.modules).filter((m) => m.kind === kind);
  return (
    <select className="select wide" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">（無）</option>}
      {modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  );
}

/** 參數的單一控制項（不打 key 的） */
function ParamWidget({ d, v, onChange }: { d: ParamDef; v: ParamValue; onChange: (v: ParamValue) => void }) {
  if (d.type === 'bool') return <label className="switch"><input type="checkbox" checked={Boolean(v)} onChange={(e) => onChange(e.target.checked)} /><span /></label>;
  if (d.type === 'color') return <input type="color" className="color" value={String(v)} onChange={(e) => onChange(e.target.value)} />;
  return <DragNumber variant="text" value={Number(v)} step={d.type === 'int' ? 1 : undefined} min={d.min} max={d.max} decimals={d.type === 'int' ? 0 : undefined} def={Number(d.def)} onChange={(x) => onChange(d.type === 'int' ? Math.round(x) : x)} />;
}

const paramRows = (defs: ParamDef[], values: ParamValues, set: (p: ParamValues) => void) =>
  defs.map((d) => ({ label: d.label, node: <ParamWidget d={d} v={values[d.name] ?? d.def} onChange={(v) => set({ ...values, [d.name]: v })} /> }));

function ClipInspector({ id }: { id: string }) {
  const clip = useStore((s) => s.clips.find((c) => c.id === id));
  const media = useStore((s) => s.media.find((m) => m.id === clip?.mediaId));
  const remapMod = useStore((s) => s.modules.find((m) => m.id === clip?.remap.moduleId));
  const time = useStore((s) => s.time);
  const modules = useStore((s) => s.modules);
  if (!clip) return null;
  const { updateClip, setRemap } = useStore.getState();
  const host = clipHost(clip.id)!;
  const local = Math.min(clip.duration, Math.max(0, time - clip.start));
  const chs = clipChannels(clip, local);
  const isVideo = media?.kind === 'video';

  /** 改速度參數時，長度與關鍵影格一起縮放（2× → 長度減半） */
  const onRemapParams = (p: ParamValues) => {
    if (clip.remap.moduleId === 'remap-speed') {
      const oldSp = Number(clip.remap.params.speed ?? 1);
      const newSp = Number(p.speed ?? 1);
      if (newSp > 0 && Math.abs(newSp - oldSp) > 1e-6) {
        const s = oldSp / newSp;
        const keys = Object.fromEntries(Object.entries(clip.keys).map(([k, l]) => [k, l!.map((x) => ({ ...x, t: x.t * s }))]));
        return updateClip(clip.id, { remap: { ...clip.remap, params: p }, duration: clip.duration * s, keys });
      }
    }
    updateClip(clip.id, { remap: { ...clip.remap, params: p } });
  };

  const sections: Section[] = [
    {
      id: 'motion',
      title: '運動',
      channels: chs.filter((c) => c.id !== 'opacity'),
      onReset: () => {
        const keys = { ...clip.keys };
        delete keys.x; delete keys.y; delete keys.scale; delete keys.rotation;
        updateClip(clip.id, { keys, transform: { ...clip.transform, x: 0, y: 0, scale: 1, rotation: 0 } });
      },
    },
    {
      id: 'opacity',
      title: '不透明度',
      channels: chs.filter((c) => c.id === 'opacity'),
      onReset: () => {
        const keys = { ...clip.keys };
        delete keys.opacity;
        updateClip(clip.id, { keys, transform: { ...clip.transform, opacity: 1 } });
      },
    },
    {
      id: 'frame',
      title: '畫面',
      rows: [
        {
          label: '填滿模式',
          node: (
            <select className="select" value={clip.fit} onChange={(e) => updateClip(clip.id, { fit: e.target.value as Fit })}>
              {Object.entries(FITS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          ),
        },
        { label: '水平翻轉', node: <label className="switch"><input type="checkbox" checked={clip.flipX} onChange={(e) => updateClip(clip.id, { flipX: e.target.checked })} /><span /></label> },
      ],
      onReset: () => updateClip(clip.id, { fit: 'cover', flipX: false, transform: { ...DEFAULT_TRANSFORM }, keys: {} }),
    },
  ];

  if (isVideo && remapMod) {
    const defs = parseParams(remapMod.code);
    sections.push({
      id: 'speed',
      title: '速度 / 時間重映射',
      rows: [
        { label: '模式', node: <ModuleSelect kind="remap" value={clip.remap.moduleId} onChange={(m) => m && setRemap(clip.id, m)} /> },
        ...paramRows(defs, clip.remap.params, onRemapParams),
        ...(clip.remap.moduleId !== 'remap-speed'
          ? [{ label: '整體速率', node: <DragNumber variant="text" value={clip.rate ?? 1} min={0.05} max={16} step={0.01} def={1} suffix="×" onChange={(v) => updateClip(clip.id, { rate: v })} /> }]
          : []),
      ],
      footer: <ModuleCode module={remapMod} onFork={(nid) => updateClip(clip.id, { remap: { ...clip.remap, moduleId: nid } })} />,
    });
  }
  if (isVideo && media?.hasAudio) {
    const ok = plainSpeed(clip, new Map(modules.map((m) => [m.id, m]))) !== null;
    sections.push({
      id: 'sound',
      title: '聲音',
      rows: [
        { label: '音量', node: <DragNumber variant="text" value={clip.volume} min={0} max={1} step={0.01} display={100} suffix="%" def={1} onChange={(v) => updateClip(clip.id, { volume: v })} /> },
        ...(!ok ? [{ label: '', node: <span className="muted small">目前的時間重映射不播放原音</span> }] : []),
      ],
    });
  }

  return <EffectControls host={host} sections={sections} title={<Title kind="k-clip" label="片段" name={media?.name ?? '（素材遺失）'} />} />;
}

function EffectInspector({ id }: { id: string }) {
  const fx = useStore((s) => s.effects.find((e) => e.id === id));
  const mod = useStore((s) => s.modules.find((m) => m.id === fx?.moduleId));
  const time = useStore((s) => s.time);
  if (!fx) return null;
  const { updateEffect } = useStore.getState();
  const host = fxHost(fx.id)!;
  const local = Math.min(fx.duration, Math.max(0, time - fx.start));
  const defs = mod ? parseParams(mod.code) : [];
  const other = defs.filter((d) => d.type === 'bool' || d.type === 'color');
  const sections: Section[] = [
    {
      id: 'fx',
      title: mod?.name ?? '特效',
      rows: [
        ...paramRows(other, fx.params, (p) => updateEffect(id, { params: p })),
      ],
      channels: mod ? fxChannels(fx, mod.code, local) : [],
      onReset: () => updateEffect(id, { params: {}, keys: {} }),
      footer: mod && <ModuleCode module={mod} onFork={(nid) => updateEffect(id, { moduleId: nid })} />,
    },
  ];
  return <EffectControls host={host} sections={sections} title={<Title kind="k-fx" label="特效" name={mod?.name ?? ''} />} />;
}

/** 沒有時間軸的屬性列表（轉場、音訊） */
function PlainControls({ title, rows, footer }: { title: React.ReactNode; rows: { label: string; node: React.ReactNode }[]; footer?: React.ReactNode }) {
  return (
    <div className="ec plain">
      <div className="ec-row ec-header"><div className="ec-left">{title}</div></div>
      {rows.map((r, i) => (
        <div key={r.label + i} className="ec-row">
          <div className="ec-left ec-plain"><span className="ec-label">{r.label}</span><div className="ec-node">{r.node}</div></div>
        </div>
      ))}
      {footer && <div className="ec-footer">{footer}</div>}
    </div>
  );
}

function TransitionInspector({ clipId }: { clipId: string }) {
  const clip = useStore((s) => s.clips.find((c) => c.id === clipId));
  const clips = useStore((s) => s.clips);
  const mod = useStore((s) => s.modules.find((m) => m.id === clip?.transitionIn?.moduleId));
  if (!clip?.transitionIn) return null;
  const { updateTransition, setTransition } = useStore.getState();
  const tr = clip.transitionIn;
  const sorted = sortClips(clips.filter((c) => c.track === clip.track));
  const prev = sorted[sorted.findIndex((c) => c.id === clipId) - 1];
  const w = transitionWindow(prev, clip);
  const maxD = prev ? Math.min(prev.duration, clip.duration) : 2;
  const defs = mod ? parseParams(mod.code) : [];
  return (
    <>
      {!w && <div className="warn" style={{ margin: 8 }}>前一個片段沒有緊貼這個片段，轉場不會生效。</div>}
      <PlainControls
        title={<><Title kind="k-tr" label="轉場" name={mod?.name ?? ''} /><button className="link danger" onClick={() => setTransition(clipId, null)}>移除</button></>}
        rows={[
          { label: '轉場', node: <ModuleSelect kind="transition" value={tr.moduleId} onChange={(m) => setTransition(clipId, m)} /> },
          { label: '長度', node: <DragNumber variant="text" value={Math.min(tr.duration, maxD)} min={0.05} max={maxD} step={0.01} suffix="s" def={0.4} onChange={(v) => updateTransition(clipId, { duration: v })} /> },
          ...paramRows(defs, tr.params, (p) => updateTransition(clipId, { params: p })),
        ]}
        footer={mod && <ModuleCode module={mod} onFork={(nid) => updateTransition(clipId, { moduleId: nid })} />}
      />
    </>
  );
}

function AudioInspector({ id }: { id: string }) {
  const a = useStore((s) => s.audios.find((c) => c.id === id));
  const media = useStore((s) => s.media.find((m) => m.id === a?.mediaId));
  if (!a) return null;
  const { updateAudio } = useStore.getState();
  return (
    <PlainControls
      title={<Title kind="k-audio" label="音訊" name={media?.name ?? '（素材遺失）'} />}
      rows={[
        { label: '音量', node: <DragNumber variant="text" value={a.volume} min={0} max={1} step={0.01} display={100} suffix="%" def={1} onChange={(v) => updateAudio(id, { volume: v })} /> },
        { label: '淡入', node: <DragNumber variant="text" value={a.fadeIn} min={0} max={Math.min(10, a.duration)} step={0.01} suffix="s" def={0} onChange={(v) => updateAudio(id, { fadeIn: v })} /> },
        { label: '淡出', node: <DragNumber variant="text" value={a.fadeOut} min={0} max={Math.min(10, a.duration)} step={0.01} suffix="s" def={0} onChange={(v) => updateAudio(id, { fadeOut: v })} /> },
        { label: '速率', node: <DragNumber variant="text" value={a.rate ?? 1} min={0.1} max={4} step={0.01} suffix="×" def={1} onChange={(v) => updateAudio(id, { rate: v, duration: a.duration * ((a.rate ?? 1) / v) })} /> },
      ]}
    />
  );
}

function ModuleInspector({ id }: { id: string }) {
  const mod = useStore((s) => s.modules.find((m) => m.id === id));
  if (!mod) return null;
  const { renameModule } = useStore.getState();
  const label = mod.kind === 'transition' ? '轉場模組' : mod.kind === 'effect' ? '特效模組' : '變速模組';
  return (
    <div className="ec plain">
      <div className="ec-row ec-header">
        <div className="ec-left">
          <span className={`kind ${mod.kind === 'transition' ? 'k-tr' : mod.kind === 'effect' ? 'k-fx' : 'k-clip'}`}>{label}</span>
          {mod.builtin ? <span className="ec-name">{mod.name}</span> : <input className="name-input" value={mod.name} onChange={(e) => renameModule(id, e.target.value)} />}
        </div>
      </div>
      <div className="ec-footer"><ModuleCode module={mod} forceOpen /></div>
    </div>
  );
}

export type { Clip, FxItem };
