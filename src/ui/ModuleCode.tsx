import { $t } from '../i18n';
import { CircleAlert, Code2 } from 'lucide-react';
import React from 'react';
import { useStore, type Module } from '../store';
import { openModuleEditor, useCodeEditor } from './CodePanel';

/** 屬性面板裡模組的一列：語言、錯誤、共用數；程式碼到「程式碼」分頁編輯 */
export function ModuleCode({ module, onFork }: { module: Module; onFork?: (newId: string) => void }) {
  const error = useStore((s) => s.errors[module.id]);
  const unsaved = useCodeEditor((s) => !!s.drafts[module.id]);
  const users = useStore(
    (s) =>
      s.clips.filter((c) => c.remap.moduleId === module.id || c.transitionIn?.moduleId === module.id || c.transitionOut?.moduleId === module.id || c.effects?.some((f) => f.moduleId === module.id)).length +
      s.effects.filter((e) => e.moduleId === module.id).length,
  );
  return (
    <div className="code-link">
      <span className="lang">{'</>'} {module.kind === 'remap' ? 'JavaScript' : 'GLSL'}</span>
      {error && <span className="err-dot" title={error}><CircleAlert size={12} /> {$t('錯誤')}</span>}
      {unsaved && <span className="cp-dirty">● {$t('未儲存')}</span>}
      <span className="spacer" />
      {users > 1 && <span className="muted small">{$t('{0} 處使用中', users)}</span>}
      {onFork && (
        <button className="link" title={$t('複製成獨立模組，只套用到目前項目')} onClick={() => { const id = useStore.getState().forkModule(module.id); onFork(id); openModuleEditor(id); }}>
          {$t('複製為新模組')}
        </button>
      )}
      {!module.builtin && <button className="btn small-h" onClick={() => openModuleEditor(module.id)}><Code2 size={12} /> {$t('編輯程式碼')}</button>}
    </div>
  );
}
