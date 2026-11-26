import { $t, displayName } from '../i18n';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, Clapperboard, CircleAlert, Copy, ExternalLink, Eye, EyeOff, Image as ImageIcon, Info, LoaderCircle, Paperclip, Plus, RefreshCw, Send, Settings, Sparkles, Square, Trash2, Wand2, X, Zap } from 'lucide-react';
import {
  MAX_FIXES, aiErrorText, applyChatProposalsToast, clearChat, isApplied, rewindChat, stepsSince, refreshModels, sendChat, stopChat, useAiChat, useAiModels, useAiSettings,
  type ChatMsg,
} from '../ai/assistant';
import { codeBlocks, detectKind, guessName, validateModule } from '../ai/validate';
import { currentModule, openNewModule, setModuleCode, useCodeEditor } from './CodePanel';
import { openMenu, toast } from './uiStore';
import { useStore } from '../store';
import { useHistory } from '../engine/history';
import { useAutoEdit } from '../engine/autoEditApply';
import { Switch, ToggleChip } from './Toggle';

const KEY_URL = 'https://aistudio.google.com/apikey';

// ───────────── 設定 ─────────────

function AiSetup({ onDone }: { onDone?: () => void }) {
  const { key, model, set } = useAiSettings();
  const models = useAiModels();
  const [draft, setDraft] = useState(key);
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    const k = draft.trim();
    set({ key: k });
    setMsg(null);
    if (!k) return;
    setTesting(true);
    const err = await refreshModels(k);
    setTesting(false);
    setMsg(err ? { ok: false, text: err } : { ok: true, text: $t('已連線') });
    if (!err) onDone?.();
  };

  return (
    <div className="ai-setup">
      <div className="ai-setup-row">
        <span className="ai-setup-label">{$t('API 金鑰')}</span>
        <a className="ai-link" href={KEY_URL} target="_blank" rel="noreferrer" title="Google AI Studio">
          {$t('取得免費金鑰')} <ExternalLink size={11} />
        </a>
        <span className="spacer" />
        <span className="ai-info" title={$t('金鑰只存在這個瀏覽器。Google 的免費方案可能會用送出的內容改善服務；送出的只有你輸入的文字、附加的模組程式碼和預覽畫面截圖。')}>
          <Info size={13} />
        </span>
      </div>
      <div className="ai-setup-row">
        <input
          className="ai-key"
          type={show ? 'text' : 'password'}
          value={draft}
          placeholder="AIza…"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <button className="ec-icon" title={show ? $t('隱藏') : $t('顯示')} onClick={() => setShow(!show)}>{show ? <EyeOff size={14} /> : <Eye size={14} />}</button>
        <button className="btn primary small-h" disabled={testing || draft.trim() === key && !!models.list.length} onClick={save}>
          {testing ? <LoaderCircle size={12} className="spin" /> : null} {$t('儲存')}
        </button>
      </div>
      {msg && <div className={msg.ok ? 'ok-line' : 'err-line'} title={msg.text}>{msg.ok ? <Check size={12} /> : <CircleAlert size={12} />} {msg.ok ? msg.text : $t('連線失敗')}</div>}
      {key && (
        <div className="ai-setup-row">
          <span className="ai-setup-label">{$t('模型')}</span>
          <ModelSelect />
          <button className="ec-icon" title={$t('重新讀取模型清單')} onClick={() => refreshModels()}>
            <RefreshCw size={13} className={models.loading ? 'spin' : ''} />
          </button>
          <span className="spacer" />
          <button className="btn small-h" onClick={() => { set({ key: '', model: '' }); setDraft(''); setMsg(null); useAiModels.setState({ list: [] }); }}>{$t('移除金鑰')}</button>
        </div>
      )}
      {key && <LookToggle />}
      {key && <CustomPrompt />}
      {model && !models.list.length && models.error && <div className="err-line" title={models.error}><CircleAlert size={12} /> {$t('讀不到模型清單')}</div>}
    </div>
  );
}

function LookToggle() {
  const look = useAiSettings((s) => s.look);
  const set = useAiSettings((s) => s.set);
  return (
    <div className="ai-setup-row" title={$t('寫好特效 / 轉場後，把套在預覽畫面上的結果給 AI 看一次，有問題就修正（每次多用一個請求）')}>
      <span className="ai-setup-label">{$t('寫完看畫面檢查')}</span>
      <span className="spacer" />
      <Switch v={look} on={(v) => set({ look: v })} />
    </div>
  );
}

function CustomPrompt() {
  const custom = useAiSettings((s) => s.custom);
  const set = useAiSettings((s) => s.set);
  return (
    <div className="ai-setup-col">
      <span className="ai-setup-label" title={$t('每次送出都會附在系統提示後面')}>{$t('自訂指示')}</span>
      <textarea
        className="ai-key ai-custom"
        rows={3}
        maxLength={2000}
        value={custom}
        spellCheck={false}
        onChange={(e) => set({ custom: e.target.value })}
      />
    </div>
  );
}

function ModelSelect() {
  const { model, set } = useAiSettings();
  const list = useAiModels((s) => s.list);
  const opts = list.length ? list : model ? [{ id: model, name: model }] : [];
  return (
    <select className="select ai-model" value={model} onChange={(e) => set({ model: e.target.value })} title={model}>
      {opts.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
    </select>
  );
}

// ───────────── 訊息內容（簡易 Markdown） ─────────────

function inline(s: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('`') ? <code key={`${key}-${k++}`}>{t.slice(1, -1)}</code> : <b key={`${key}-${k++}`}>{t.slice(2, -2)}</b>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function Prose({ text }: { text: string }) {
  const lines = text.replace(/^\n+|\n+$/g, '').split('\n');
  const out: React.ReactNode[] = [];
  let list: React.ReactNode[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`l${out.length}`}>{list}</ul>);
    list = [];
  };
  lines.forEach((l, i) => {
    const b = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
    if (b) return list.push(<li key={i}>{inline(b[1], `i${i}`)}</li>);
    flush();
    const h = /^#{1,4}\s+(.*)$/.exec(l);
    if (h) out.push(<div key={i} className="ai-h">{inline(h[1], `h${i}`)}</div>);
    else if (l.trim()) out.push(<p key={i}>{inline(l, `p${i}`)}</p>);
  });
  flush();
  return <>{out}</>;
}

function CodeCard({ code, lang, live, msg }: { code: string; lang: string; live: boolean; msg: ChatMsg }) {
  const kind = detectKind(code);
  // 回覆的主要模組用已經驗證過的結果；其他區塊自己驗證一次
  const error = useMemo(() => {
    if (live || !kind) return undefined;
    if (msg.check && msg.check.code === code) return msg.check.error;
    return validateModule(kind, code);
  }, [live, kind, code, msg.check]);
  const target = msg.attach?.id ? { ...msg.attach, id: msg.attach.id } : undefined;
  return (
    <div className="ai-code">
      <div className="ai-code-head">
        <span className="ai-code-lang">{lang || 'code'}</span>
        {kind && !live && (error ? (
          <span className="err-line" title={error}><CircleAlert size={12} /> {$t('編譯錯誤')}</span>
        ) : (
          <span className="ok-line"><Check size={12} /> {$t('編譯通過')}</span>
        ))}
        <span className="spacer" />
        {!live && (
          <>
            <button className="ec-icon" title={$t('複製')} onClick={() => navigator.clipboard?.writeText(code).then(() => toast($t('已複製')))}><Copy size={12} /></button>
            {kind && target && target.kind === kind && (
              <button className="btn small-h" title={target.name} onClick={() => setModuleCode(target.id, code)}>
                <Wand2 size={12} /> {$t('套用到目前模組')}
              </button>
            )}
            {kind && (
              <button className="btn small-h" onClick={() => openNewModule(kind, guessName(code), code)}>
                <Plus size={12} /> {$t('建立為新模組')}
              </button>
            )}
          </>
        )}
      </div>
      <pre className="ai-code-body">{code}</pre>
    </div>
  );
}

function ProposalCard({ msg }: { msg: ChatMsg }) {
  const list = msg.proposals!;
  const apply = () => applyChatProposalsToast(msg.id);
  useHistory((h) => h.ver); // 復原 / 重做後重新判斷「已套用」
  return (
    <div className="ai-code">
      <div className="ai-code-head">
        <span className="ai-code-lang">{$t('修改')}</span>
        <span className="spacer" />
        {isApplied(msg) ? (
          <span className="ok-line"><Check size={12} /> {$t('已套用')}</span>
        ) : (
          <button className="btn small-h" disabled={!!msg.streaming} onClick={apply}><Wand2 size={12} /> {$t('套用')}</button>
        )}
      </div>
      <ul className="ai-ops">{list.map((p, i) => <li key={i}>{p.summary}</li>)}</ul>
    </div>
  );
}

function MsgBody({ msg }: { msg: ChatMsg }) {
  const live = !!msg.streaming;
  const blocks = codeBlocks(msg.text);
  const parts: React.ReactNode[] = [];
  let last = 0;
  blocks.forEach((b, k) => {
    if (b.start > last) parts.push(<Prose key={`t${k}`} text={msg.text.slice(last, b.start)} />);
    parts.push(<CodeCard key={`c${k}`} code={b.code} lang={b.lang} live={live && k === blocks.length - 1} msg={msg} />);
    last = b.end;
  });
  if (last < msg.text.length) parts.push(<Prose key="tail" text={msg.text.slice(last)} />);
  return <>{parts}</>;
}

function Message({ msg }: { msg: ChatMsg }) {
  if (msg.role === 'user') {
    const menu = (e: React.MouseEvent) => {
      e.preventDefault();
      const sel = getSelection()?.toString();
      const steps = stepsSince(msg);
      openMenu(e.clientX, e.clientY, [
        { label: $t('複製'), action: () => navigator.clipboard?.writeText(sel || msg.text).then(() => toast($t('已複製'))) },
        { separator: true },
        { label: $t('從這裡重來'), action: () => rewindChat(msg.id) },
        { label: steps ? $t('從這裡重來並復原 {0} 步', steps) : $t('從這裡重來並復原修改'), action: steps ? () => rewindChat(msg.id, true) : undefined, danger: true },
      ]);
    };
    return (
      <div className="ai-msg user" onContextMenu={menu}>
        <div className="ai-bubble">
          {msg.attach && <span className="ai-chip" title={msg.attach.code}><Paperclip size={11} /> {msg.attach.name}</span>}
          {msg.image && <img className="ai-shot" src={msg.image} alt="" />}
          <div className="ai-user-text">{msg.text}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="ai-msg model">
      {!!msg.refs?.length && <span className="ai-status muted"><BookOpen size={11} /> {$t('參考：{0}', msg.refs.map(displayName).join('、'))}</span>}
      {msg.text && <MsgBody msg={msg} />}
      {!!msg.seen?.length && (
        <div className="ai-shots" title={$t('給 AI 看的畫面')}>
          {msg.seen.map((u, i) => <img key={i} src={u} alt="" />)}
        </div>
      )}
      {msg.streaming && !!msg.seen?.length && !msg.fixing && <span className="ai-status"><LoaderCircle size={12} className="spin" /> {$t('檢查畫面中')}</span>}
      {!!msg.proposals?.length && <ProposalCard msg={msg} />}
      {msg.steps && (
        <div className="ai-code">
          <div className="ai-code-head">
            <span className="ai-code-lang">{$t('自動剪輯')}</span>
            <span className="spacer" />
            {msg.steps.running && <span className="ai-status"><LoaderCircle size={12} className="spin" /> {msg.steps.label || $t('進行中')}</span>}
          </div>
          {!!msg.steps.lines.length && <ul className="ai-ops">{msg.steps.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
        </div>
      )}
      {msg.streaming && !msg.text && <span className="muted small"><LoaderCircle size={12} className="spin" /> {$t('思考中')}</span>}
      {msg.fixing ? <span className="ai-status"><LoaderCircle size={12} className="spin" /> {$t('修正中 {0}/{1}', msg.fixing, MAX_FIXES)}</span> : null}
      {!msg.streaming && !!msg.fixes && <span className="ai-status muted">{$t('已自動修正 {0} 次', msg.fixes)}</span>}
      {msg.error && <div className="err-line" title={msg.error.message}><CircleAlert size={12} /> {aiErrorText(msg.error)}</div>}
    </div>
  );
}

// ───────────── 面板 ─────────────

export function AiPanel() {
  const key = useAiSettings((s) => s.key);
  const model = useAiSettings((s) => s.model);
  const { msgs, busy } = useAiChat();
  const [setup, setSetup] = useState(false);
  const [text, setText] = useState('');
  // 從這裡重來：訊息放回輸入框
  const draft = useAiChat((s) => s.draft);
  useEffect(() => { if (draft) setText(draft.text); }, [draft?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const [attachOn, setAttachOn] = useState(true);
  const [frameOn, setFrameOn] = useState(false);
  const director = useAutoEdit((x) => x.director);
  const directorNote = useAutoEdit((x) => x.directorNote);
  const autoOn = useAiSettings((s) => s.auto);
  const setAi = useAiSettings((s) => s.set);
  // 程式碼分頁目前打開的模組（可以附加到問題裡）
  useCodeEditor((s) => s.active);
  useCodeEditor((s) => s.drafts);
  useCodeEditor((s) => s.pending);
  useStore((s) => s.modules);
  const cur = currentModule();
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (key && !useAiModels.getState().list.length) void refreshModels();
  }, [key]);

  // 新訊息 / 串流時自動捲到底（使用者往上捲就不跟）
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const send = (t = text) => {
    if (!t.trim() || busy) return;
    sendChat(t.trim(), attachOn && cur ? { id: cur.id, name: cur.name, kind: cur.kind, code: cur.code } : undefined, frameOn);
    setText('');
    stick.current = true;
  };

  if (!key) {
    return (
      <div className="ai-panel">
        <div className="ai-empty-setup">
          <Sparkles size={22} className="ai-logo" />
          <AiSetup />
        </div>
      </div>
    );
  }

  const SUGGEST = [$t('在每個重拍加震動'), $t('寫一個跟著節拍閃爍的特效'), $t('寫一個向左推的轉場'), $t('怎麼加關鍵影格？')];

  return (
    <div className="ai-panel">
      <div className="ai-head">
        <span className="ai-model-name" title={model}>{model}</span>
        <span className="spacer" />
        <button className="ec-icon" title={$t('清除對話')} disabled={!msgs.length} onClick={clearChat}><Trash2 size={13} /></button>
        <button className={`ec-icon ${setup ? 'on' : ''}`} title={$t('AI 設定')} onClick={() => setSetup(!setup)}><Settings size={13} /></button>
      </div>
      {setup && <AiSetup onDone={() => setSetup(false)} />}
      <div className="ai-msgs" ref={listRef} onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        {msgs.length === 0 && (
          <div className="ai-suggest">
            {SUGGEST.map((s) => <button key={s} className="ai-suggest-btn" onClick={() => send(s)}>{s}</button>)}
          </div>
        )}
        {msgs.map((m) => <Message key={m.id} msg={m} />)}
      </div>
      <div className="ai-compose">
        <div className="ai-chips">
          {cur && (
            <ToggleChip v={attachOn} on={setAttachOn} title={attachOn ? $t('不附加') : $t('附加目前的模組')}>
              <Paperclip size={11} /> {cur.name}
            </ToggleChip>
          )}
          <ToggleChip v={frameOn} on={setFrameOn} title={frameOn ? $t('不附加') : $t('附加預覽畫面')}>
            <ImageIcon size={11} /> {$t('預覽畫面')}
          </ToggleChip>
          <ToggleChip v={autoOn} on={(v) => setAi({ auto: v })} title={$t('AI 提議的修改直接套用')}>
            <Zap size={11} /> {$t('自動套用')}
          </ToggleChip>
          <ToggleChip v={director} on={(v) => useAutoEdit.getState().set({ director: v })} title={directorNote || $t('自動剪輯時 AI 先看過素材再分配')}>
            <Clapperboard size={11} /> {$t('AI 導演')}
          </ToggleChip>
          {director && directorNote && (
            <span className="ai-chip ai-note" title={directorNote}>
              <span>{directorNote}</span>
              <button title={$t('清除指示')} onClick={() => useAutoEdit.getState().set({ directorNote: '' })}><X size={10} /></button>
            </span>
          )}
        </div>
        <div className="ai-input-row">
          <textarea
            className="ai-input"
            rows={2}
            value={text}
            placeholder={$t('問問題，或描述想要的特效…')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          {busy ? (
            <button className="ai-send stop" title={$t('停止')} onClick={stopChat}><Square size={13} /></button>
          ) : (
            <button className="ai-send" title={$t('送出 (Enter)')} disabled={!text.trim()} onClick={() => send()}><Send size={14} /></button>
          )}
        </div>
      </div>
    </div>
  );
}
