import { $t, displayName } from '../i18n';
import { ArrowRightLeft, CircleAlert, Gauge, MoreHorizontal, Save, Plus, Sparkles, Wand2, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { cpp } from '@codemirror/lang-cpp';
import { NEW_MODULE_TEMPLATES } from '../modules/builtin';
import { useStore, type ModuleKind } from '../store';
import { useDock } from './Dock';
import { closeEditorWindow, useEditorWindow } from './EditorWindow';
import { confirmDialog, openMenu, toast } from './uiStore';
import { AiEditBar } from './AiEdit';

/**
 * 「程式碼」分頁：編輯自訂模組（轉場 / 特效 / 變速），可以同時開好幾個（分頁內的分頁）。
 * - 名稱與程式碼都是草稿，按「儲存」（Ctrl+S）才套用。
 * - 新增的模組一開始只存在這裡（pending），第一次儲存才加進模組庫、變成素材庫裡的卡片。
 * - 關掉有未儲存變更的分頁會先詢問。
 */

type Draft = { code?: string; name?: string };
/** 還沒儲存過的新模組 */
type Pending = { kind: ModuleKind; name: string; code: string };

interface CodeEditorState {
  tabs: string[];
  active: string | null;
  drafts: Record<string, Draft>;
  pending: Record<string, Pending>;
}
export const useCodeEditor = create<CodeEditorState>(() => ({ tabs: [], active: null, drafts: {}, pending: {} }));

const NEW_NAME = (): Record<ModuleKind, string> => ({ effect: $t('新特效'), transition: $t('新轉場'), remap: $t('新變速') });
const KIND_LABEL = (): Record<ModuleKind, string> => ({ transition: $t('轉場模組'), effect: $t('特效模組'), remap: $t('變速模組') });
const KIND_CLS: Record<ModuleKind, string> = { transition: 'k-tr', effect: 'k-fx', remap: 'k-clip' };
/** 分頁上的類型圖示（不用圓點：圓點是「未儲存」） */
const KIND_ICON: Record<ModuleKind, React.ReactNode> = { effect: <Sparkles size={12} />, transition: <ArrowRightLeft size={12} />, remap: <Gauge size={12} /> };

/** 分頁對應的內容：已儲存的模組或還沒儲存的新模組 */
function resolve(id: string) {
  const p = useCodeEditor.getState().pending[id];
  if (p) return { id, kind: p.kind, name: p.name, code: p.code, isNew: true };
  const m = useStore.getState().modules.find((x) => x.id === id);
  return m && !m.builtin ? { id, kind: m.kind, name: m.name, code: m.code, isNew: false } : null;
}

function isDirty(id: string) {
  const r = resolve(id);
  if (!r) return false;
  if (r.isNew) return true;
  const d = useCodeEditor.getState().drafts[id];
  return (d?.code !== undefined && d.code !== r.code) || (d?.name !== undefined && d.name !== r.name);
}

function setDraft(id: string, d: Draft | null) {
  const drafts = { ...useCodeEditor.getState().drafts };
  if (d && (d.code !== undefined || d.name !== undefined)) drafts[id] = d;
  else delete drafts[id];
  useCodeEditor.setState({ drafts });
}

function openTab(id: string) {
  if (useEditorWindow.getState().open) closeEditorWindow(); // 編輯視窗會蓋住分頁
  const s = useCodeEditor.getState();
  useCodeEditor.setState({ tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id });
  useDock.getState().activatePanel('code');
}

/** 在「程式碼」分頁打開這個模組（只有自訂模組能編輯；內建的請先複製） */
export function openModuleEditor(id: string) {
  if (useStore.getState().modules.find((m) => m.id === id)?.builtin) return;
  openTab(id);
}

/** 新增自訂模組：先在程式碼分頁編輯，儲存後才加進模組庫 */
export function newModule(kind: ModuleKind) {
  const id = `new:${kind}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const s = useCodeEditor.getState();
  useCodeEditor.setState({ pending: { ...s.pending, [id]: { kind, name: NEW_NAME()[kind], code: NEW_MODULE_TEMPLATES[kind] } } });
  openTab(id);
}

/** 用指定的程式碼開一個新模組（AI 產生的）：跟「新增」一樣，儲存後才加進模組庫 */
export function openNewModule(kind: ModuleKind, name: string | null, code: string) {
  const id = `new:${kind}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const s = useCodeEditor.getState();
  useCodeEditor.setState({ pending: { ...s.pending, [id]: { kind, name: name || NEW_NAME()[kind], code } } });
  openTab(id);
}

/** 把程式碼放進某個分頁的草稿（還沒儲存） */
export function setModuleCode(id: string, code: string) {
  if (!resolve(id)) return toast($t('找不到這個模組'), 'error');
  setDraft(id, { ...useCodeEditor.getState().drafts[id], code });
  openTab(id);
}

/** 程式碼分頁目前打開的模組（含還沒儲存的修改） */
export function currentModule(): { id: string; kind: ModuleKind; name: string; code: string } | null {
  const { active, drafts } = useCodeEditor.getState();
  const r = active ? resolve(active) : null;
  if (!r) return null;
  return { id: r.id, kind: r.kind, name: displayName(drafts[r.id]?.name ?? r.name), code: drafts[r.id]?.code ?? r.code };
}

/** 把分頁拿掉（不詢問） */
function dropTab(id: string) {
  const s = useCodeEditor.getState();
  const i = s.tabs.indexOf(id);
  const tabs = s.tabs.filter((t) => t !== id);
  const pending = { ...s.pending };
  delete pending[id];
  const drafts = { ...s.drafts };
  delete drafts[id];
  const active = s.active === id ? tabs[Math.min(i, tabs.length - 1)] ?? null : s.active;
  useCodeEditor.setState({ tabs, pending, drafts, active });
}

/** 關閉分頁：有未儲存的變更先問 */
async function closeTab(id: string) {
  if (isDirty(id)) {
    const r = resolve(id);
    const name = displayName(useCodeEditor.getState().drafts[id]?.name ?? r?.name ?? '');
    const ok = await confirmDialog({ title: $t('捨棄變更？'), message: $t('「{0}」還沒儲存。', name), ok: $t('捨棄'), danger: true });
    if (!ok) return;
  }
  dropTab(id);
}

/** 儲存：新模組 → 加進模組庫；已有的 → 更新 */
function save(id: string) {
  const r = resolve(id);
  if (!r || !isDirty(id)) return;
  const d = useCodeEditor.getState().drafts[id];
  const name = d?.name?.trim() || r.name;
  const code = d?.code ?? r.code;
  const S = useStore.getState();
  if (r.isNew) {
    const newId = S.createModule(r.kind, { name, code });
    const s = useCodeEditor.getState();
    const pending = { ...s.pending };
    delete pending[id];
    const drafts = { ...s.drafts };
    delete drafts[id];
    useCodeEditor.setState({ tabs: s.tabs.map((t) => (t === id ? newId : t)), active: s.active === id ? newId : s.active, pending, drafts });
  } else {
    if (d?.code !== undefined) S.updateModuleCode(id, d.code);
    if (d?.name !== undefined) S.renameModule(id, name);
    setDraft(id, null);
  }
  toast($t('已儲存「{0}」', displayName(name)));
}

function newMenu(e: React.MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(r.left, r.bottom + 2, [
    { label: $t('新特效'), action: () => newModule('effect') },
    { label: $t('新轉場'), action: () => newModule('transition') },
    { label: $t('新變速'), action: () => newModule('remap') },
  ]);
}

export function CodePanel() {
  const { tabs, active, drafts, pending } = useCodeEditor();
  const modules = useStore((s) => s.modules);
  // 模組被刪掉（例如從素材庫）→ 分頁也拿掉
  useEffect(() => {
    for (const t of tabs) if (!resolve(t)) dropTab(t);
  }, [tabs, modules, pending]);

  if (!tabs.length) {
    return (
      <div className="code-panel empty">
        <div className="btn-row">
          <button className="btn small-h" onClick={() => newModule('effect')}><Plus size={12} /> {$t('新特效')}</button>
          <button className="btn small-h" onClick={() => newModule('transition')}><Plus size={12} /> {$t('新轉場')}</button>
          <button className="btn small-h" onClick={() => newModule('remap')}><Plus size={12} /> {$t('新變速')}</button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="code-panel"
      onKeyDownCapture={(e) => {
        // Ctrl+S：存目前的模組（不是存專案）
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          e.stopPropagation();
          if (active) save(active);
        }
      }}
    >
      <div className="cp-tabs">
        {tabs.map((t) => {
          const r = resolve(t);
          if (!r) return null;
          const dirty = isDirty(t);
          return (
            <div
              key={t}
              className={`cp-tab ${t === active ? 'on' : ''}`}
              onClick={() => useCodeEditor.setState({ active: t })}
              onAuxClick={(e) => e.button === 1 && closeTab(t)}
              title={displayName(drafts[t]?.name ?? r.name)}
            >
              <span className={`cp-tab-kind ${KIND_CLS[r.kind]}`}>{KIND_ICON[r.kind]}</span>
              <span className="cp-tab-name">{displayName(drafts[t]?.name ?? r.name)}</span>
              <button
                className={`cp-tab-x ${dirty ? 'dirty' : ''}`}
                title={$t('關閉')}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t);
                }}
              >
                <span className="dot">●</span>
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button className="cp-tab-new" title={$t('新增自訂模組')} onClick={newMenu}><Plus size={13} /></button>
      </div>
      {active && resolve(active) && <Editor key={active} id={active} />}
    </div>
  );
}

function Editor({ id }: { id: string }) {
  const draft = useCodeEditor((s) => s.drafts[id]);
  useCodeEditor((s) => s.pending[id]);
  useStore((s) => s.modules);
  const r = resolve(id)!;
  const error = useStore((s) => s.errors[id]);
  const users = useStore(
    (s) =>
      s.clips.filter((c) => c.remap.moduleId === id || c.transitionIn?.moduleId === id || c.transitionOut?.moduleId === id || c.effects?.some((f) => f.moduleId === id)).length +
      s.effects.filter((e) => e.moduleId === id).length,
  );
  const ext = useMemo(() => [r.kind === 'remap' ? javascript() : cpp()], [r.kind]);
  const dirty = isDirty(id);
  const name = draft?.name ?? r.name;
  const [ai, setAi] = useState(false);

  const more = (e: React.MouseEvent) => {
    const rc = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const S = useStore.getState();
    openMenu(rc.left, rc.bottom + 2, [
      { label: $t('捨棄變更'), action: !r.isNew && dirty ? () => setDraft(id, null) : undefined },
      { label: $t('複製為新模組'), action: !r.isNew ? () => openModuleEditor(S.forkModule(id)) : undefined },
      { separator: true },
      {
        label: $t('刪除模組'),
        danger: true,
        action:
          !r.isNew && !users
            ? async () => {
                if (!(await confirmDialog({ title: $t('刪除模組？'), message: $t('「{0}」會從模組庫移除。', displayName(r.name)), ok: $t('刪除'), danger: true }))) return;
                S.removeModule(id);
                dropTab(id);
              }
            : undefined,
      },
    ]);
  };

  return (
    <>
      <div className="cp-head">
        <span className={`kind ${KIND_CLS[r.kind]}`}>{KIND_LABEL()[r.kind]}</span>
        <input
          className="name-input cp-name"
          value={name}
          onChange={(e) => setDraft(id, { ...useCodeEditor.getState().drafts[id], name: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && save(id)}
          title={$t('模組名稱')}
        />
        {dirty && <span className="cp-dirty">● {r.isNew ? $t('尚未加入模組庫') : $t('未儲存')}</span>}
        <span className="spacer" />
        <button className={`btn small-h ${ai ? 'on-accent' : ''}`} onClick={() => setAi(!ai)}><Wand2 size={12} /> {$t('AI 修改')}</button>
        <button className="btn primary small-h" disabled={!dirty} onClick={() => save(id)} title={$t('儲存 (Ctrl+S)')}><Save size={12} /> {$t('儲存')}</button>
        <button className="ec-icon" title={$t('更多')} onClick={more}><MoreHorizontal size={14} /></button>
      </div>
      <div className="cp-sub">
        <span className="lang">{'</>'} {r.kind === 'remap' ? 'JavaScript' : 'GLSL'}</span>
        {users > 0 && <span className="muted">{$t('{0} 處使用中', users)}</span>}
        {error && <span className="err-dot" title={error}><CircleAlert size={12} /> {$t('編譯錯誤')}</span>}
      </div>
      {ai && (
        <AiEditBar
          kind={r.kind}
          name={displayName(name)}
          code={draft?.code ?? r.code}
          onApply={(code) => setDraft(id, { ...useCodeEditor.getState().drafts[id], code })}
          onClose={() => setAi(false)}
        />
      )}
      <div className="cp-editor">
        <CodeMirror
          value={draft?.code ?? r.code}
          theme="dark"
          extensions={ext}
          onChange={(v) => setDraft(id, { ...useCodeEditor.getState().drafts[id], code: v })}
          basicSetup={{ foldGutter: false, highlightActiveLine: true }}
          height="100%"
          className="cm cp-cm"
        />
      </div>
      {error && <pre className="err cp-err">{error}</pre>}
    </>
  );
}
