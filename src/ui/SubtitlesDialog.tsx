import { useEffect, useMemo, useRef, useState } from 'react';
import { updateText } from '../engine/textAnchor';
import { Film, MoreHorizontal, Plus, Replace, TriangleAlert } from 'lucide-react';
import { $t } from '../i18n';
import { downloadBlob } from '../engine/exporter';
import {
  addCue, addSrtCues, captionList, formatTc, isCaptionClip, mergeCueWithNext, parseLrc, parseSrt, parseTc,
  readingSpeed, removeCue, replaceInCaptions, setTrackCaptions, splitCue, writeLrc, writeSrt,
} from '../engine/subtitles';
import { useStore, type Clip } from '../store';
import { pickFiles } from '../engine/media';
import { openMenu, promptDialog, toast, type MenuItem } from './uiStore';
import { LibFilter, LibToolbar } from './Library';
import { DragNumber } from './DragNumber';
import { Seg } from './Toggle';
import { usePrefs } from '../prefs';
import { mixdown } from '../engine/audio';
import { projectDuration } from '../store';
import { autoSubtitles, mono16k, releaseSpeech, ModelUnavailable, useSpeechJob } from '../engine/speech';
import { ModelDeclined } from '../engine/models';

const MIN_DUR = 0.05;

/** 同一軌上前後的片段（字幕時間不能跟它們重疊） */
function neighbors(c: Clip) {
  const same = useStore.getState().clips.filter((x) => x.track === c.track && x.id !== c.id);
  const prevEnd = Math.max(0, ...same.filter((x) => x.start + x.duration <= c.start + 1e-4).map((x) => x.start + x.duration));
  const nextStart = Math.min(Infinity, ...same.filter((x) => x.start >= c.start + c.duration - 1e-4).map((x) => x.start));
  return { prevEnd, nextStart };
}

function setCueTime(c: Clip, field: 'start' | 'end', value: number) {
  const s = useStore.getState();
  if (s.tracks.video[c.track]?.locked || !Number.isFinite(value)) return;
  const { prevEnd, nextStart } = neighbors(c);
  const end = c.start + c.duration;
  if (field === 'start') {
    const v = Math.min(end - MIN_DUR, Math.max(prevEnd, value));
    s.updateClip(c.id, { start: v, duration: end - v });
  } else {
    const v = Math.max(c.start + MIN_DUR, Math.min(nextStart, value));
    s.updateClip(c.id, { duration: v - c.start });
  }
}

type Cat = 'all' | 'warn';

/** 自動字幕：語言、範圍（整個專案 / 循環範圍 / 自訂） */
function AutoSubDialog({ busy, close, start }: { busy: boolean; close: () => void; start: (range: { a: number; b: number }) => void }) {
  const language = usePrefs((s) => s.subtitleLanguage);
  const full = useStore((s) => projectDuration(s));
  const loop = useStore((s) => s.loop);
  const [mode, setMode] = useState<'all' | 'loop' | 'custom'>(loop ? 'loop' : 'all');
  const [custom, setCustom] = useState(() => ({ a: loop?.a ?? 0, b: Math.min(loop?.b ?? full, full) }));
  const range = mode === 'loop' && loop ? { a: loop.a, b: Math.min(loop.b, full) } : mode === 'custom' ? custom : { a: 0, b: full };
  const dur = Math.max(0, range.b - range.a);
  return (
    <div className="overlay dialog-overlay" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog auto-sub" role="dialog" aria-modal="true" aria-label={$t('自動字幕')}>
        <h3>{$t('自動字幕')}</h3>
        <div className="form-row col"><span>{$t('語言')}</span><Seg value={language} opts={[{ v: 'auto', label: $t('自動') }, { v: 'zh', label: $t('中文') }, { v: 'en', label: 'English' }, { v: 'ja', label: $t('日本語') }]} on={(v) => usePrefs.getState().set({ subtitleLanguage: v })} /></div>
        <div className="form-row col">
          <span>{$t('範圍')}</span>
          <Seg value={mode} on={setMode} opts={[{ v: 'all' as const, label: $t('整個專案') }, ...(loop ? [{ v: 'loop' as const, label: $t('循環範圍') }] : []), { v: 'custom' as const, label: $t('自訂') }]} />
        </div>
        {mode === 'custom' && <div className="form-row auto-sub-range">
          <DragNumber value={custom.a} min={0} max={Math.max(0, custom.b - 0.5)} step={0.1} suffix=" s" onChange={(v) => setCustom((c) => ({ ...c, a: Math.round(v * 10) / 10 }))} />
          <span>–</span>
          <DragNumber value={custom.b} min={Math.min(full, custom.a + 0.5)} max={full} step={0.1} suffix=" s" onChange={(v) => setCustom((c) => ({ ...c, b: Math.round(v * 10) / 10 }))} />
        </div>}
        <div className="form-row"><span>{$t('長度')}</span><b>{formatTc(dur)}</b></div>
        <div className="dialog-actions">
          <button className="btn" onClick={close}>{$t('取消')}</button>
          <button className="btn primary" disabled={busy || dur <= 0} onClick={() => start(range)}>{$t('開始')}</button>
        </div>
      </div>
    </div>
  );
}

export function LyricsPanel() {
  const allClips = useStore((s) => s.clips);
  const tracks = useStore((s) => s.tracks);
  const selId = useStore((s) => (s.selection?.type === 'clip' ? s.selection.id : null));
  const playing = useStore((s) => s.playing);
  const activeId = useStore((s) => s.clips.find((c) => isCaptionClip(c) && !s.tracks.video[c.track]?.noCaptions && s.time >= c.start && s.time < c.start + c.duration)?.id ?? null);
  const clips = useMemo(() => captionList(allClips, tracks), [allClips, tracks]);
  // 有字幕的影片軌（含不接收的），給使用者勾選要接收哪些
  const capTracks = useMemo(() => {
    const n = new Map<number, number>();
    for (const c of allClips) if (isCaptionClip(c)) n.set(c.track, (n.get(c.track) ?? 0) + 1);
    return [...n.entries()].filter(([i]) => tracks.video[i]).sort((a, b) => a[0] - b[0]);
  }, [allClips, tracks]);
  const anyOff = capTracks.some(([i]) => tracks.video[i]?.noCaptions);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Cat>('all');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const language = usePrefs((s) => s.subtitleLanguage);
  const job = useSpeechJob((s) => s.stage);
  const controller = useRef<AbortController | null>(null);
  const [rep, setRep] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const boxes = useRef(new Map<string, HTMLTextAreaElement>());
  const rows = useRef(new Map<string, HTMLDivElement>());
  const bodyRef = useRef<HTMLDivElement>(null);

  const warnings = useMemo(() => {
    const out = new Map<string, string[]>();
    clips.forEach((c, i) => {
      const w: string[] = [];
      const prev = clips[i - 1];
      if (!c.text!.text.trim()) w.push($t('沒有內容'));
      if (prev && c.start < prev.start + prev.duration - 1e-3) w.push($t('跟上一段重疊'));
      const sp = readingSpeed(c.text!.text, c.duration);
      if (sp.fast) w.push($t('字太多、顯示時間太短（每秒 {0} 字）', sp.cps.toFixed(1)));
      if (w.length) out.set(c.id, w);
    });
    return out;
  }, [clips]);

  const shown = clips.filter((c) => (cat === 'all' || warnings.has(c.id)) && (!q || c.text!.text.toLowerCase().includes(q.toLowerCase())));
  const hits = q ? clips.reduce((n, c) => n + (c.text!.text.split(q).length - 1), 0) : 0;

  // 新增 / 分割後把游標放到那段字幕
  useEffect(() => {
    if (!focusId) return;
    const el = boxes.current.get(focusId);
    if (el) {
      el.focus();
      el.setSelectionRange(0, 0);
      setFocusId(null);
    }
  }, [focusId, clips]);

  // 播放中：目前這段捲到看得到的地方；時間軸上選了某段字幕也一樣（正在打字時不動）
  const follow = playing ? activeId : selId;
  useEffect(() => {
    if (!follow || bodyRef.current?.contains(document.activeElement)) return;
    rows.current.get(follow)?.scrollIntoView({ block: 'nearest' });
  }, [follow]);

  const isLocked = (c: Clip) => !!tracks.video[c.track]?.locked;
  const seek = (c: Clip) => {
    const s = useStore.getState();
    s.setTime(c.start);
    s.select({ type: 'clip', id: c.id });
  };
  const add = () => {
    const id = addCue(useStore.getState().time);
    if (id) {
      setCat('all');
      setQ('');
      setFocusId(id);
    } else toast($t('這裡沒有空間放新字幕'), 'error');
  };
  const split = (c: Clip, caret?: number) => {
    const id = splitCue(c.id, useStore.getState().time, caret);
    if (id) setFocusId(id);
  };

  const importCues = async () => {
    const [file] = await pickFiles('.srt,.lrc', false);
    if (!file) return;
    const lrc = file.name.toLowerCase().endsWith('.lrc');
    const count = addSrtCues(lrc ? parseLrc(await file.text()) : parseSrt(await file.text()), lrc ? 'LRC' : 'SRT');
    toast(count ? $t('已匯入 {0} 段字幕', count) : $t('找不到有效字幕'), count ? undefined : 'error');
  };
  const startAuto = async (range: { a: number; b: number }) => {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    useSpeechJob.setState({ stage: $t('混音中'), done: 0, total: 1, cancel: () => abort.abort() });
    setAutoOpen(false);
    try {
      const s = useStore.getState(), duration = range.b - range.a;
      const mixed = duration > 0 ? await mixdown(s, new Map(s.modules.map((m) => [m.id, m])), duration, range.a) : null;
      if (abort.signal.aborted) return;
      if (!mixed) { toast($t('時間軸上沒有聲音'), 'error'); return; }
      const cues = await autoSubtitles(await mono16k(mixed), language, abort.signal);
      if (abort.signal.aborted) return;
      const count = addSrtCues(cues.map((c) => ({ ...c, start: c.start + range.a, end: c.end + range.a })), 'AI');
      toast(count ? $t('已加入 {0} 段字幕', count) : $t('沒有辨識到人聲'), count ? 'info' : 'error');
    } catch (error) {
      if (error instanceof ModelUnavailable) toast($t('模型無法下載'), 'error');
      else if (!(error instanceof ModelDeclined) && (error as Error).name !== 'AbortError') {
        console.error('[auto subtitles]', error);
        toast($t('自動字幕失敗：{0}', error instanceof Error ? error.message : String(error)), 'error');
      }
    } finally { releaseSpeech(); controller.current = null; useSpeechJob.setState({ stage: null, done: 0, total: 1, cancel: null }); }
  };
  const exportCues = (format: 'SRT' | 'LRC') => {
    const data = format === 'SRT' ? writeSrt(clips) : writeLrc(clips);
    if (data) downloadBlob(new Blob(['﻿', data], { type: 'text/plain;charset=utf-8' }), `YBeat_lyrics.${format.toLowerCase()}`);
  };
  const shiftAll = async () => {
    const v = await promptDialog({ title: $t('全部時間位移（秒）'), value: '0' });
    const d = Number(v);
    if (!v || !Number.isFinite(d) || !d) return;
    const s = useStore.getState();
    const ids = new Set(clips.filter((c) => !isLocked(c)).map((c) => c.id));
    useStore.setState({ clips: s.clips.map((c) => (ids.has(c.id) ? { ...c, start: Math.max(0, c.start + d) } : c)) });
  };
  const moreMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom, [
      { label: $t('匯入 SRT／LRC…'), action: importCues },
      { label: $t('自動字幕…'), action: () => setAutoOpen(true) },
      { label: $t('匯出 SRT'), action: clips.length ? () => exportCues('SRT') : undefined },
      { label: $t('匯出 LRC'), action: clips.length ? () => exportCues('LRC') : undefined },
      { separator: true },
      { label: $t('全部時間位移…'), action: clips.length ? shiftAll : undefined },
    ]);
  };
  const doReplace = () => {
    const n = replaceInCaptions(q, rep);
    toast(n ? $t('已取代 {0} 處', n) : $t('找不到符合的文字'), n ? undefined : 'error');
  };

  const cueMenu = (e: React.MouseEvent, c: Clip, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const locked = isLocked(c);
    const t = () => useStore.getState().time;
    const items: MenuItem[] = [
      { label: $t('開始設為播放頭'), action: locked ? undefined : () => setCueTime(c, 'start', t()) },
      { label: $t('結束設為播放頭'), action: locked ? undefined : () => setCueTime(c, 'end', t()) },
      { separator: true },
      { label: $t('在播放頭分割'), action: locked ? undefined : () => split(c) },
      { label: $t('與下一段合併'), action: !locked && clips[i + 1] ? () => mergeCueWithNext(c.id) : undefined },
      { separator: true },
      { label: $t('刪除'), danger: true, action: locked ? undefined : () => removeCue(c.id) },
    ];
    openMenu(e.clientX, e.clientY, items);
  };

  const onTextKey = (e: React.KeyboardEvent<HTMLTextAreaElement>, c: Clip, i: number) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      split(c, el.selectionStart);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const next = clips[i + 1];
      if (next) {
        boxes.current.get(next.id)?.focus();
        seek(next);
      } else add();
    } else if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0 && i > 0) {
      const prev = clips[i - 1];
      const caret = prev.text!.text.trim().length;
      if (mergeCueWithNext(prev.id)) {
        e.preventDefault();
        requestAnimationFrame(() => {
          const box = boxes.current.get(prev.id);
          box?.focus();
          box?.setSelectionRange(caret, caret);
        });
      }
    }
  };

  const warnCount = warnings.size;
  const empty = !clips.length ? (anyOff ? $t('沒有接收的字幕') : $t('還沒有字幕')) : cat === 'warn' ? $t('沒有需要注意的字幕') : $t('沒有符合的字幕');

  return (
    <div className="lib lyrics-panel">
      {autoOpen && <AutoSubDialog busy={!!job} close={() => setAutoOpen(false)} start={(r) => void startAuto(r)} />}
      <LibToolbar id="lyrics" query={q} setQuery={setQ} views={false} filter={{ active: cat !== 'all', reset: () => setCat('all') }}>
        <button className={`lib-add ${replaceOpen ? 'on' : ''}`} title={$t('取代')} onClick={() => setReplaceOpen(!replaceOpen)}><Replace size={14} /></button>
        <button className="lib-add" title={$t('在播放頭新增字幕')} onClick={add}><Plus size={15} /></button>
        <button className="lib-add" title={$t('更多')} onClick={moreMenu}><MoreHorizontal size={15} /></button>
      </LibToolbar>
      {replaceOpen && (
        <div className="cue-replace">
          <input className="text-input" placeholder={$t('取代為…')} value={rep} onChange={(e) => setRep(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') doReplace(); }} />
          <button className="btn small" disabled={!hits} onClick={doReplace}>{$t('全部取代')}{hits ? `（${hits}）` : ''}</button>
        </div>
      )}
      <LibFilter id="lyrics" cats={[{ id: 'all', label: $t('全部'), count: clips.length }, { id: 'warn', label: $t('需注意'), count: warnCount }]} cur={cat} set={(v) => setCat(v as Cat)} />
      {(capTracks.length > 1 || anyOff) && (
        <div className="lib-filter cue-tracks">
          {capTracks.map(([i, n]) => {
            const on = !tracks.video[i]?.noCaptions;
            return (
              <button key={i} className={on ? 'on' : ''} title={on ? $t('不接收這條軌道的字幕') : $t('接收這條軌道的字幕')} onClick={() => setTrackCaptions(i, !on)}>
                <Film size={11} />{$t('影片')} {i + 1}<span>{n}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="lib-body cue-list" ref={bodyRef}>
        {!shown.length && <p className="muted small center">{empty}</p>}
        {shown.map((c) => {
          const i = clips.indexOf(c);
          const locked = isLocked(c);
          const w = warnings.get(c.id);
          return (
            <div
              key={c.id}
              ref={(el) => { if (el) rows.current.set(c.id, el); else rows.current.delete(c.id); }}
              className={`cue ${c.id === activeId ? 'active' : ''} ${c.id === selId ? 'sel' : ''} ${locked ? 'locked' : ''}`}
              onClick={(e) => { if (!(e.target as Element).closest('input, textarea, button, .dragnum')) seek(c); }}
              onContextMenu={(e) => cueMenu(e, c, i)}
            >
              <div className="cue-meta">
                <span className="cue-idx">{i + 1}</span>
                <DragNumber value={c.start} min={0} step={0.1} decimals={2} format={formatTc} parse={parseTc} disabled={locked} onChange={(v) => setCueTime(c, 'start', v)} />
                <span className="muted">→</span>
                <DragNumber value={c.start + c.duration} min={0} step={0.1} decimals={2} format={formatTc} parse={parseTc} disabled={locked} onChange={(v) => setCueTime(c, 'end', v)} />
                <span className="cue-dur muted small">{c.duration.toFixed(1)}s</span>
                {w && <span className="cue-warn" title={w.join('\n')}><TriangleAlert size={12} /></span>}
                <button className="cue-more" title={$t('更多')} onClick={(e) => cueMenu(e, c, i)}><MoreHorizontal size={14} /></button>
              </div>
              <textarea
                ref={(el) => { if (el) boxes.current.set(c.id, el); else boxes.current.delete(c.id); }}
                className="text-input cue-text"
                rows={Math.min(4, Math.max(1, c.text!.text.split('\n').length))}
                value={c.text!.text}
                disabled={locked}
                onFocus={() => { const s = useStore.getState(); if (s.selection?.id !== c.id) s.select({ type: 'clip', id: c.id }); }}
                onChange={(e) => updateText(c.id, { text: e.target.value })}
                onKeyDown={(e) => onTextKey(e, c, i)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
