/**
 * 渲染进程入口。
 *
 * 这里只做三件事：挂根节点、装全局样式、告诉主进程「我准备好了」。
 * 所有状态都在 App 里，方便主进程的任何命令（菜单、拖放）都以 App 为单一入口。
 */

import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { notifyMain } from './lib/api';
import './styles/app.css';
import { bridgeReady } from './lib/tauri-bridge';

const container = document.getElementById('root');
if (!container) {
  // index.html 是我们自己的，缺 #root 说明产物被换了；抛出来比白屏好排查。
  throw new Error('index.html 缺少 #root 挂载点');
}

function DesktopApp(): JSX.Element {
  const ready = useRef(false);
  useEffect(() => {
    if (!ready.current) {
      ready.current = true;
      notifyMain('renderer:ready');
    }
  }, []);
  return <App />;
}

void bridgeReady.then(() => {
  createRoot(container).render(
    <StrictMode>
      <DesktopApp />
    </StrictMode>,
  );
}).catch(error => {
  container.textContent = `桌面接口初始化失败：${String(error)}`;
  console.error('[arale] bridge initialization', error);
});
