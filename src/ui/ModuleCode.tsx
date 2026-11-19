import { $t } from '../i18n';
import { ChevronDown, ChevronRight, CircleAlert } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { cpp } from '@codemirror/lang-cpp';
import { BUILTIN_MODULES } from '../modules/builtin';
import { useStore, type Module } from '../store';
import { useLayout } from './uiStore';

/** 模組程式碼編輯器：打字即時套用（防抖），編譯錯誤會顯示但預覽保留上一個可用版本 */
export function ModuleCode({ module, onFork, forceOpen }: { module: Module; onFork?: (newId: string) => void; forceOpen?: boolean }) {
  const { updateModuleCode, forkModule, resetModule } = useStore.getState();
  const error = useStore((s) => s.errors[module.id]);
  const users = useStore(
    (s) =>
      s.clips.filter((c) => c.remap.moduleId === module.id || c.transitionIn?.moduleId === module.id || c.transitionOut?.moduleId === module.id).length +
      s.effects.filter((e) => e.moduleId === module.id).length,
  );
  const [text, setText] = useState(module.code);
  const committed = useRef(module.code);
  const timer = useRef<number>();
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (module.code !== committed.current) {
      setText(module.code);
      committed.current = module.code;
    }
  }, [module.id, module.code]);

  const flush = () => {
    clearTimeout(timer.current);
    if (pending.current !== null) {
      committed.current = pending.current;
      updateModuleCode(module.id, pending.current);
      pending.current = null;
    }
  };
  useEffect(() => flush, [module.id]); // 切換模組 / 卸載前存檔

  const onChange = (v: string) => {
    setText(v);
    pending.current = v;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 250);
  };

  const codeH = useLayout((s) => s.codeH);
  const resize = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = codeH;
    document.body.classList.add('resizing-h');
    const mv = (ev: PointerEvent) => useLayout.getState().set({ codeH: Math.round(Math.min(1400, Math.max(120, h0 + ev.clientY - y0))) });
    const up = () => {
      document.body.classList.remove('resizing-h');
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const ext = useMemo(() => [module.kind === 'remap' ? javascript() : cpp()], [module.kind]);
  const builtin = BUILTIN_MODULES.find((b) => b.id === module.id);
  const dirty = builtin && builtin.code !== module.code;

  const codeOpen = useLayout((s) => s.codeOpen);
  const open = forceOpen || codeOpen;

  return (
    <div className={`code-block ${open ? 'open' : ''}`}>
      <div className="code-head" onClick={() => !forceOpen && useLayout.getState().set({ codeOpen: !codeOpen })}>
        {!forceOpen && <span className="caret">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>}
        <span className="lang">{'</>'} {module.kind === 'remap' ? 'JavaScript' : 'GLSL'}</span>
        {error && <span className="err-dot" title={error}><CircleAlert size={12} /> {$t('錯誤')}</span>}
        <span className="spacer" />
        {open && users > 1 && <span className="muted small">{$t('共用')}{' '}{users}{' '}{$t('處')}</span>}
        {open && onFork && (
          <button className="link" title={$t('複製成獨立模組，只套用到目前項目')} onClick={(e) => { e.stopPropagation(); onFork(forkModule(module.id)); }}>
            {$t('複製為新模組')}
          </button>
        )}
        {open && dirty && (
          <button className="link" onClick={(e) => { e.stopPropagation(); resetModule(module.id); }}>
            {$t('重置')}
          </button>
        )}
      </div>
      {open && (
        <>
          <CodeMirror
            value={text}
            theme="dark"
            extensions={ext}
            onChange={onChange}
            basicSetup={{ foldGutter: false, highlightActiveLine: true }}
            className="cm"
            height={`${codeH}px`}
          />
          <div className="code-resize" onPointerDown={resize} title={$t('拖曳調整編輯器高度')} />
          {error && <pre className="err">{error}</pre>}
        </>
      )}
    </div>
  );
}
