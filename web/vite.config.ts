import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = 'http://127.0.0.1:9999';

export default defineConfig({
  plugins: [react()],
  // 相对路径：构建产物既能被本地服务托管，也能直接双击 index.html 打开（只读浏览）
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true }
    }
  }
});
