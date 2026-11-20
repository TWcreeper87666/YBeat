import { useState } from 'react';
import { $t } from '../i18n';
import { downloadBlob } from '../engine/exporter';
import { addSrtCues, isCaptionClip, parseLrc, parseSrt, writeLrc, writeSrt } from '../engine/subtitles';
import { useStore, type Clip } from '../store';
import { pickFiles } from '../engine/media';
import { toast } from './uiStore';

export function LyricsPanel() {
  const clips = useStore((s) => s.clips.filter(isCaptionClip).sort((a, b) => a.start - b.start));
  const [offset, setOffset] = useState(0);
  const updateTime = (c: Clip, field: 'start' | 'end', raw: string) => {
    const s = useStore.getState();
    if (s.tracks.video[c.track]?.locked) return;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    if (field === 'start') s.updateClip(c.id, { start: value, duration: Math.max(.01, c.start + c.duration - value) });
    else if (value > c.start) s.updateClip(c.id, { duration: value - c.start });
  };
  const importCues = async () => {
    const [file] = await pickFiles('.srt,.lrc', false);
    if (!file) return;
    const lrc = file.name.toLowerCase().endsWith('.lrc');
    const count = addSrtCues(lrc ? parseLrc(await file.text()) : parseSrt(await file.text()), lrc ? 'LRC' : 'SRT');
    toast(count ? $t('已匯入 {0} 段字幕', count) : $t('找不到有效字幕'), count ? undefined : 'error');
  };
  const exportCues = (format: 'SRT' | 'LRC') => {
    const data = format === 'SRT' ? writeSrt(clips) : writeLrc(clips);
    if (data) downloadBlob(new Blob(['\uFEFF', data], { type: 'text/plain;charset=utf-8' }), `YBeat_lyrics.${format.toLowerCase()}`);
  };
  const shiftAll = () => {
    const s = useStore.getState();
    for (const c of clips) if (!s.tracks.video[c.track]?.locked) s.updateClip(c.id, { start: Math.max(0, c.start + offset) });
  };
  return <div className="lyrics-panel">
    <h3>{$t('字幕／歌詞')}</h3>
    <div className="subtitle-actions">
      <button className="btn" onClick={importCues}>{$t('匯入 SRT／LRC…')}</button>
      <button className="btn" onClick={() => exportCues('SRT')} disabled={!clips.length}>{$t('匯出 SRT')}</button>
      <button className="btn" onClick={() => exportCues('LRC')} disabled={!clips.length}>{$t('匯出 LRC')}</button>
    </div>
    <div className="subtitle-shift">
      <label>{$t('全部時間位移（秒）')} <input className="text-input" type="number" step="0.1" value={offset} onChange={(e) => setOffset(Number(e.target.value))} /></label>
      <button className="btn" onClick={shiftAll} disabled={!clips.length || !offset}>{$t('套用')}</button>
    </div>
    <div className="subtitle-list">
      <div className="subtitle-head"><span>#</span><span>{$t('開始')}</span><span>{$t('結束')}</span><span>{$t('內容')}</span></div>
      {clips.map((c, i) => {
        const locked = !!useStore.getState().tracks.video[c.track]?.locked;
        return <div className="subtitle-row" key={c.id}>
          <button className="subtitle-index" title={$t('跳轉')} onClick={() => { useStore.getState().setTime(c.start); useStore.getState().select({ type: 'clip', id: c.id }); }}>{i + 1}</button>
          <input key={`${c.id}:start:${c.start}`} className="text-input" type="number" step="0.01" min="0" defaultValue={c.start.toFixed(2)} disabled={locked} onBlur={(e) => updateTime(c, 'start', e.target.value)} />
          <input key={`${c.id}:end:${c.start + c.duration}`} className="text-input" type="number" step="0.01" min="0.01" defaultValue={(c.start + c.duration).toFixed(2)} disabled={locked} onBlur={(e) => updateTime(c, 'end', e.target.value)} />
          <textarea className="text-input" rows={Math.min(3, Math.max(1, c.text!.text.split('\n').length))} value={c.text!.text} disabled={locked} onChange={(e) => useStore.getState().updateClip(c.id, { text: { ...c.text!, text: e.target.value } })} />
        </div>;
      })}
      {!clips.length && <p className="muted">{$t('目前沒有字幕或歌詞。可匯入 SRT／LRC，或從文字素材加入字幕。')}</p>}
    </div>
  </div>;
}

export function SubtitlesDialog({ close }: { close: () => void }) {
  return <div className="dialog wide subtitle-dialog">
    <LyricsPanel />
    <div className="dialog-actions"><button className="btn primary" onClick={close}>{$t('完成')}</button></div>
  </div>;
}
