import { $t } from '../i18n';
import React, { useRef, useState } from 'react';
import { Check, CircleAlert, LoaderCircle, Send, Square, X } from 'lucide-react';
import type { ModuleKind } from '../store';
import { aiErrorText, editModule, toAiError, useAiSettings, MAX_FIXES, type AiError } from '../ai/assistant';
import { hunks, lineDiff } from '../ai/diff';
import { useDock } from './Dock';

type State =
  | { s: 'idle' }
  | { s: 'run'; chars: number; fixing: number }
  | { s: 'done'; code: string; note: string; error: string | null; fixes: number }
  | { s: 'fail'; err: AiError | { kind: 'nocode'; message: string } };

/** 程式碼分頁上方的「AI 修改」：輸入要怎麼改 → 顯示差異 → 套用（變成未儲存的草稿） */
export function AiEditBar({ kind, name, code, onApply, onClose }: { kind: ModuleKind; name: string; code: string; onApply: (code: string) => void; onClose: () => void }) {
  const hasKey = useAiSettings((s) => !!s.key);
  const [req, setReq] = useState('');
  const [st, setSt] = useState<State>({ s: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const base = useRef(code);

  const run = async () => {
    if (!req.trim() || st.s === 'run') return;
    base.current = code;
    const ac = new AbortController();
    abort.current = ac;
    setSt({ s: 'run', chars: 0, fixing: 0 });
    try {
      const r = await editModule({
        kind,
        name,
        code,
        request: req.trim(),
        signal: ac.signal,
        onText: (t) => setSt((p) => (p.s === 'run' ? { ...p, chars: t.length } : p)),
        onFix: (n) => setSt((p) => (p.s === 'run' ? { ...p, fixing: n } : p)),
      });
      if (!r.code) setSt({ s: 'fail', err: { kind: 'nocode', message: r.error ?? r.note } });
      else setSt({ s: 'done', code: r.code, note: r.note, error: r.error, fixes: r.fixes });
    } catch (e) {
      if (ac.signal.aborted) setSt({ s: 'idle' });
      else setSt({ s: 'fail', err: toAiError(e) });
    }
  };

  if (!hasKey) {
    return (
      <div className="ai-edit">
        <span className="muted small">{$t('還沒有設定 API 金鑰')}</span>
        <button className="btn small-h" onClick={() => useDock.getState().activatePanel('ai')}>{$t('設定')}</button>
        <span className="spacer" />
        <button className="ec-icon" title={$t('關閉')} onClick={onClose}><X size={14} /></button>
      </div>
    );
  }

  return (
    <>
      <div className="ai-edit">
        <input
          className="ai-edit-input"
          autoFocus
          value={req}
          placeholder={$t('要怎麼改？')}
          disabled={st.s === 'run'}
          onChange={(e) => setReq(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) run();
            if (e.key === 'Escape') (st.s === 'run' ? abort.current?.abort() : onClose());
          }}
        />
        {st.s === 'run' ? (
          <>
            <span className="muted small ai-edit-status">
              <LoaderCircle size={12} className="spin" /> {st.fixing ? $t('修正中 {0}/{1}', st.fixing, MAX_FIXES) : st.chars ? `${st.chars}` : ''}
            </span>
            <button className="ec-icon" title={$t('停止')} onClick={() => abort.current?.abort()}><Square size={12} /></button>
          </>
        ) : (
          <button className="ec-icon" title={$t('送出 (Enter)')} disabled={!req.trim()} onClick={run}><Send size={13} /></button>
        )}
        <button className="ec-icon" title={$t('關閉')} onClick={() => { abort.current?.abort(); onClose(); }}><X size={14} /></button>
      </div>
      {st.s === 'fail' && (
        <div className="ai-edit-msg err-line">
          <CircleAlert size={12} /> {st.err.kind === 'nocode' ? $t('回覆裡沒有程式碼') : aiErrorText(st.err as AiError)}
        </div>
      )}
      {st.s === 'done' && (
        <div className="ai-diff-wrap">
          <div className="ai-diff-head">
            {st.error ? (
              <span className="err-line" title={st.error}><CircleAlert size={12} /> {$t('編譯錯誤')}</span>
            ) : (
              <span className="ok-line"><Check size={12} /> {st.fixes ? $t('已自動修正 {0} 次', st.fixes) : $t('編譯通過')}</span>
            )}
            {st.note && <span className="muted small ai-diff-note" title={st.note}>{st.note}</span>}
            <span className="spacer" />
            <button className="btn small-h" onClick={() => setSt({ s: 'idle' })}>{$t('取消')}</button>
            <button className="btn primary small-h" onClick={() => { onApply(st.code); setSt({ s: 'idle' }); setReq(''); }}>{$t('套用')}</button>
          </div>
          <DiffView a={base.current} b={st.code} />
        </div>
      )}
    </>
  );
}

function DiffView({ a, b }: { a: string; b: string }) {
  const rows = hunks(lineDiff(a, b), 3);
  if (!rows.some((r) => r && r.op !== ' ')) return <div className="ai-diff muted small">{$t('沒有變更')}</div>;
  return (
    <pre className="ai-diff">
      {rows.map((r, k) =>
        r ? (
          <div key={k} className={`dl ${r.op === '+' ? 'add' : r.op === '-' ? 'del' : ''}`}>
            <span className="op">{r.op}</span>
            {r.text || ' '}
          </div>
        ) : (
          <div key={k} className="dl gap">⋯</div>
        ),
      )}
    </pre>
  );
}
