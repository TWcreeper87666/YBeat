import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { useStore } from './store';
import { restoreProject } from './engine/project';
import { installAppBehavior } from './ui/Menu';
import { installFileDrop } from './ui/dnd';
import { restoreTimelineView } from './ui/timelineView';

installAppBehavior();
installFileDrop();
restoreTimelineView();
restoreProject();
createRoot(document.getElementById('root')!).render(<App />);

// 除錯用：在 DevTools 可以用 __store.getState() 查看狀態
(window as unknown as { __store: typeof useStore }).__store = useStore;
