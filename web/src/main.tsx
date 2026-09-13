import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installPageLifecycle } from './pageLifecycle';
import './styles/app.css';

// 关闭网页 → 自动关闭本地服务（有任务在跑时先弹浏览器原生二次确认）
installPageLifecycle();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
