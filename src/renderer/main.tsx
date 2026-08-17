import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createLocalApi } from './localApi';
import './styles.css';

// 不在 Electron（无 preload 注入的 window.api）时，用样例数据兜底，保证 UI 可预览。
if (typeof window.api === 'undefined') {
  window.api = createLocalApi();
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
