import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Renderer (React UI) build config.
// Main/preload are compiled via `tsc -p tsconfig.node.json` to dist-electron.
//
// 仅在构建期把「是否配置了令牌」的布尔注入前端（define 文本替换），
// 不会注入任何密钥值本身（安全）。浏览器预览据此正确反映 .env 配置状态，
// 并在用户点击真实抓取 / 大模型能力时给出「需用桌面端」的准确提示。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const tikhubConfigured = !!(env.TIKHUB_API_TOKEN && env.TIKHUB_API_TOKEN.trim());
  const videoConfigured = !!(env.VIDEO_API_KEY && env.VIDEO_API_KEY.trim());

  return {
    root: 'src/renderer',
    plugins: [react()],
    base: './',
    define: {
      __TIKHUB_CONFIGURED__: JSON.stringify(tikhubConfigured),
      __VIDEO_CONFIGURED__: JSON.stringify(videoConfigured),
    },
    build: {
      outDir: resolve(__dirname, 'dist'),
      emptyOutDir: true,
    },
    server: {
      port: 5174,
      strictPort: true,
    },
  };
});
