import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closeMenu, openMenu, useDrag, useMenu, useToast, type MenuItem } from './uiStore';

// ───────────── 右鍵 / 下拉選單 ─────────────

export function MenuHost() {
  const menu = useMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(menu.x, innerWidth - r.width - 6)), y: Math.max(4, Math.min(menu.y, innerHeight - r.height - 6)) });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest('.menubar-item') && menu.owner === 'menubar') return;
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div ref={ref} className="ctxmenu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((it, i) =>
        'separator' in it ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            disabled={it.disabled || !it.action}
            className={it.danger ? 'danger' : ''}
            onClick={() => {
              closeMenu();
              it.action?.();
            }}
          >
            <span className="mcheck">{it.checked ? '✓' : ''}</span>
            <span className="mlabel">{it.label}</span>
            <kbd>{it.shortcut ?? ''}</kbd>
          </button>
        ),
      )}
    </div>
  );
}

// ───────────── 選單列（檔案 / 編輯 / 檢視 / 說明）─────────────

export function MenuBar({ menus }: { menus: { label: string; items: () => MenuItem[] }[] }) {
  const menu = useMenu((s) => s.menu);
  const [active, setActive] = useState<number | null>(null);
  const open = menu?.owner === 'menubar';

  useEffect(() => {
    if (!open) setActive(null);
  }, [open]);

  const show = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setActive(i);
    openMenu(r.left, r.bottom + 2, menus[i].items(), 'menubar');
  };

  return (
    <nav className="menubar">
      {menus.map((m, i) => (
        <button
          key={m.label}
          className={`menubar-item ${open && active === i ? 'on' : ''}`}
          onPointerDown={(e) => {
            if (open && active === i) closeMenu();
            else show(i, e.currentTarget);
          }}
          onPointerEnter={(e) => open && active !== i && show(i, e.currentTarget)}
        >
          {m.label}
        </button>
      ))}
    </nav>
  );
}

// ───────────── 拖曳中的 ghost ─────────────

export function DragGhost() {
  const drag = useDrag((s) => s.drag);
  if (!drag || drag.payload.kind === 'files') return null;
  const ok = !!drag.target && !(drag.target.kind === 'clip' && !drag.target.valid);
  return (
    <div className={`drag-ghost ${ok ? 'ok' : ''}`} style={{ left: drag.x + 14, top: drag.y + 10 }}>
      {drag.thumb && <div className="drag-thumb" style={{ backgroundImage: `url(${drag.thumb})` }} />}
      <span>{drag.label}</span>
      <em>{!drag.target ? '拖到時間軸上' : drag.target.kind === 'clip' ? (drag.target.action === 'relink' ? '重新連結素材' : drag.target.action === 'transition' ? '設為進場轉場' : '套用變速') : '放開以加入'}</em>
    </div>
  );
}

// ───────────── 提示 ─────────────

export function Toasts() {
  const toasts = useToast((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
      ))}
    </div>
  );
}

// ───────────── 像真正的 App：攔截瀏覽器預設行為 ─────────────

const isTextField = (el: Element | null) => !!el?.closest('input:not([type=range]):not([type=checkbox]):not([type=color]), textarea, .cm-editor, [contenteditable]');

/** 文字欄位 / 程式碼編輯器的右鍵選單（取代瀏覽器的） */
function textMenu(x: number, y: number) {
  const sel = document.getSelection()?.toString() ?? '';
  const exec = (cmd: string) => () => document.execCommand(cmd);
  openMenu(x, y, [
    { label: '復原', shortcut: 'Ctrl+Z', action: exec('undo') },
    { label: '重做', shortcut: 'Ctrl+Y', action: exec('redo') },
    { separator: true },
    { label: '剪下', shortcut: 'Ctrl+X', action: sel ? exec('cut') : undefined },
    { label: '複製', shortcut: 'Ctrl+C', action: sel ? exec('copy') : undefined },
    {
      label: '貼上',
      shortcut: 'Ctrl+V',
      action: async () => {
        try {
          const text = await navigator.clipboard.readText();
          document.execCommand('insertText', false, text);
        } catch {
          /* 沒有剪貼簿權限時忽略 */
        }
      },
    },
    { separator: true },
    { label: '全選', shortcut: 'Ctrl+A', action: exec('selectAll') },
  ]);
}

export function installAppBehavior() {
  // 任何地方都不開瀏覽器右鍵選單；文字欄位改用自己的
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const el = e.target as HTMLElement;
    if (isTextField(el)) textMenu(e.clientX, e.clientY);
  });
  // 禁止 Ctrl+滾輪 / 觸控板縮放整個頁面
  window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
  // 禁止中鍵自動捲動、圖片與連結的原生拖曳
  window.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault());
  window.addEventListener('dragstart', (e) => {
    if (!(e.target as HTMLElement).closest?.('[draggable=true]')) e.preventDefault();
  });
  // 單按 Alt 不要讓瀏覽器把焦點移到選單列（Alt+拖曳 = 滑移素材）
  window.addEventListener('keyup', (e) => e.key === 'Alt' && e.preventDefault());
  // 按鈕點完就失焦，避免 Space / Enter 再次觸發按鈕
  window.addEventListener('pointerup', () => {
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === 'BUTTON' || (a.tagName === 'INPUT' && (a as HTMLInputElement).type === 'checkbox'))) a.blur();
  });
  // 瀏覽器快捷鍵（存檔 / 列印 / 開啟 / 尋找…）一律攔截
  window.addEventListener(
    'keydown',
    (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === 'F1' || e.key === 'F3' || e.key === 'F7' || e.key === 'Alt') e.preventDefault();
        return;
      }
      const k = e.key.toLowerCase();
      // 文字欄位 / 程式碼編輯器裡保留編輯用的快捷鍵（Ctrl+D、Ctrl+F…），只擋瀏覽器層級的
      const browserOnly = ['s', 'p', 'o', 'e', 'g', 'h', 'j', 'u'];
      const appKeys = ['d', 'b', 'k', 'l', 'f'];
      if (browserOnly.includes(k) || (appKeys.includes(k) && !isTextField(document.activeElement))) e.preventDefault();
      if (['=', '+', '-', '0'].includes(k)) e.preventDefault(); // 瀏覽器縮放
    },
    { capture: true },
  );
}
