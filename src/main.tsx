import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { useStore } from './store';
import { restoreProject } from './engine/project';
import { installAppBehavior } from './ui/Menu';
import { installFileDrop } from './ui/dnd';
import { installOverlayScrollbars } from './ui/overlayScrollbar';
import { installMiddlePan } from './ui/middlePan';
import { restoreTimelineView } from './ui/timelineView';
import { startProxies } from './engine/proxy';
import { applyAppearance } from './prefs';

applyAppearance();
installAppBehavior();
installFileDrop();
installOverlayScrollbars();
installMiddlePan();
restoreTimelineView();
// 專案載入完才開始產生 / 載入預覽代理檔
void restoreProject().finally(startProxies);
createRoot(document.getElementById('root')!).render(<App />);

// 除錯用：在 DevTools 可以用 __store.getState() 查看狀態
(window as unknown as { __store: typeof useStore }).__store = useStore;
