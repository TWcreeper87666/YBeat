import { $t } from '../i18n';
import { Check, ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closeMenu, openMenu, useConfirm, useDrag, useMenu, useToast, type MenuItem } from './uiStore';
import { installFocusGuard, isTextField } from './focus';

// ───────────── 右鍵 / 下拉選單 ─────────────

export function MenuHost() {
  const menu = useMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);

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
    <div ref={ref} className="ctxmenu-root" onContextMenu={(e) => e.preventDefault()}>
      <MenuList key={`${menu.x},${menu.y}`} items={menu.items} at={{ x: menu.x, y: menu.y }} />
    </div>
  );
}

/** 一層選單；有子選單的項目滑過去（或點一下）在旁邊展開，右邊放不下就往左 */
function MenuList({ items, at, from }: { items: MenuItem[]; at: { x: number; y: number }; from?: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const [sub, setSub] = useState<{ i: number; rect: DOMRect } | null>(null);
  const timer = useRef<number>();

  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    let x = at.x;
    // 子選單：右邊放不下 → 放到父項目左邊
    if (from && x + r.width > innerWidth - 6) x = from.left - r.width + 2;
    setPos({ x: Math.max(4, Math.min(x, innerWidth - r.width - 6)), y: Math.max(4, Math.min(at.y, innerHeight - r.height - 6)) });
  }, [at, from]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const openSub = (i: number, el: HTMLElement, delay: number) => {
    clearTimeout(timer.current);
    const go = () => setSub({ i, rect: el.getBoundingClientRect() });
    if (delay) timer.current = window.setTimeout(go, delay);
    else go();
  };

  return (
    <>
      <div ref={ref} className="ctxmenu" style={{ left: pos.x, top: pos.y }}>
        {items.map((it, i) =>
          'separator' in it ? (
            <div key={i} className="menu-sep" />
          ) : it.submenu ? (
            <button
              key={i}
              disabled={it.disabled || !it.submenu.length}
              className={`has-sub ${sub?.i === i ? 'open' : ''}`}
              onPointerEnter={(e) => openSub(i, e.currentTarget, 120)}
              onClick={(e) => openSub(i, e.currentTarget, 0)}
            >
              <span className="mcheck" />
              <span className="mlabel">{it.label}</span>
              <ChevronRight size={12} className="msub" />
            </button>
          ) : (
            <button
              key={i}
              disabled={it.disabled || !it.action}
              className={it.danger ? 'danger' : ''}
              onPointerEnter={() => {
                clearTimeout(timer.current);
                timer.current = window.setTimeout(() => setSub(null), 120);
              }}
              onClick={() => {
                closeMenu();
                it.action?.();
              }}
            >
              <span className="mcheck">{it.checked ? <Check size={11} /> : ''}</span>
              <span className="mlabel">{it.label}</span>
              <kbd>{it.shortcut ?? ''}</kbd>
            </button>
          ),
        )}
      </div>
      {sub && (() => {
        const it = items[sub.i];
        return it && !('separator' in it) && it.submenu ? <MenuList key={sub.i} items={it.submenu} at={{ x: sub.rect.right - 2, y: sub.rect.top - 4 }} from={sub.rect} /> : null;
      })()}
    </>
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
  const color = drag.payload.kind === 'color' ? drag.payload.color : undefined;
  return (
    <div className={`drag-ghost ${ok ? 'ok' : ''}`} style={{ left: drag.x + 14, top: drag.y + 10 }}>
      {(drag.thumb || color) && <div className="drag-thumb" style={{ backgroundImage: drag.thumb ? `url(${drag.thumb})` : undefined, background: color }} />}
      <div className="drag-info">
      <span>{drag.label}</span>
      <em>
        {!drag.target
          ? $t('拖到時間軸上')
          : drag.payload.kind === 'mask'
            ? drag.target.kind === 'effect' ? $t('設為這個特效的遮罩形狀') : $t('設為片段的遮罩形狀')
          : drag.target.kind === 'effect'
            ? $t('取代這個特效')
            : drag.target.kind === 'clip' && drag.target.action === 'effect'
              ? $t('加到這個片段的特效')
            : drag.target.kind === 'clip'
              ? drag.target.action === 'relink' ? $t('重新連結素材') : drag.target.action === 'transition' ? $t('設為進場轉場') : drag.target.action === 'transitionOut' ? $t('設為轉出') : $t('套用變速')
              : $t('放開以加入')}
      </em>
      </div>
    </div>
  );
}

// ───────────── 確認對話框 ─────────────

export function ConfirmHost() {
  const req = useConfirm((s) => s.req);
  const [text, setText] = useState('');
  /** 目前選中的按鈕：0 = 取消、1 = 確定（預設確定，跟以前按 Enter 的結果一樣） */
  const [sel, setSel] = useState(1);
  useEffect(() => {
    setText(req?.input ?? '');
    setSel(1);
    // 沒有輸入框：讓原本的焦點（例如屬性面板的欄位）離開，← / → / Enter 才會作用在對話框的按鈕上
    if (req && req.input === undefined) (document.activeElement as HTMLElement | null)?.blur?.();
  }, [req]);
  useEffect(() => {
    if (!req) return;
    const k = (e: KeyboardEvent) => {
      const inText = isTextField(e.target);
      if (e.key === 'Escape') done(false);
      // 輸入框裡按 Enter = 確定；其他時候 Enter 按下目前選中的按鈕
      else if (e.key === 'Enter') { e.preventDefault(); done(inText ? true : sel === 1); }
      // ← / → 切換按鈕（輸入框裡留給游標移動）
      else if (!inText && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab')) {
        e.preventDefault();
        setSel(e.key === 'ArrowLeft' ? 0 : e.key === 'ArrowRight' ? 1 : 1 - sel);
      }
      // 輸入框要能打字；其他按鍵不要觸發編輯器快捷鍵
      else if (inText) return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });
  if (!req) return null;
  function done(v: boolean) {
    useConfirm.setState({ req: null });
    req!.resolve(v, text);
  }
  return (
    <div className="overlay" style={{ zIndex: 300 }} onPointerDown={(e) => e.target === e.currentTarget && done(false)}>
      <div className="dialog">
        <h3>{req.title}</h3>
        {req.message && <p className="muted">{req.message}</p>}
        {req.input !== undefined && (
          <input className="text-input" autoFocus value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        )}
        <div className="dialog-actions">
          <button className={`btn ${sel === 0 && req.input === undefined ? 'sel' : ''}`} onClick={() => done(false)} onPointerEnter={() => setSel(0)}>{$t('取消')}</button>
          <button className={`btn ${req.danger ? 'danger-fill' : 'primary'} ${sel === 1 && req.input === undefined ? 'sel' : ''}`} onClick={() => done(true)} onPointerEnter={() => setSel(1)}>{req.ok}</button>
        </div>
      </div>
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


/** 文字欄位 / 程式碼編輯器的右鍵選單（取代瀏覽器的） */
function textMenu(x: number, y: number) {
  const sel = document.getSelection()?.toString() ?? '';
  const exec = (cmd: string) => () => document.execCommand(cmd);
  openMenu(x, y, [
    { label: $t('復原'), shortcut: 'Ctrl+Z', action: exec('undo') },
    { label: $t('重做'), shortcut: 'Ctrl+Y', action: exec('redo') },
    { separator: true },
    { label: $t('剪下'), shortcut: 'Ctrl+X', action: sel ? exec('cut') : undefined },
    { label: $t('複製'), shortcut: 'Ctrl+C', action: sel ? exec('copy') : undefined },
    {
      label: $t('貼上'),
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
    { label: $t('全選'), shortcut: 'Ctrl+A', action: exec('selectAll') },
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
  // 控制項點完就失焦、焦點卡住時按鍵照常作用（規則見 focus.ts）
  installFocusGuard();
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
      // Ctrl + / Ctrl - / Ctrl 0 交給瀏覽器縮放整個介面（介面放大縮小都能正常用）；Ctrl+滾輪仍然攔下（觸控板手勢很容易誤觸）
    },
    { capture: true },
  );
}
