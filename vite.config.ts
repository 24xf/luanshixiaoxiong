import { defineConfig } from 'vitest/config';

// 前端工程化（#16）：Vite 作为前端构建/dev server，输出到 public/dist 由后端托管。
// - root=client：前端源码根（index.html + src/）
// - build.outDir=../public/dist：相对 client 向上一级到项目根，再进 public/dist
// - dev：vite 跑在 5173，把 /socket.io、/health、/metrics 代理到后端 3000（含 ws）
// - test：Vitest 纯逻辑单测（node 环境）
export default defineConfig({
  root: 'client',
  base: '/',
  build: {
    outDir: '../public/dist',
    // 关闭 Vite 自动清空：本沙箱环境的"安全删除(回收站)"拦截 fs.rm 会失败；
    // 旧哈希资源未被 index.html 引用即失效，且 public/dist 已 gitignore，无副作用。
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://localhost:3001', ws: true },
      '/api': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/metrics': 'http://localhost:3001',
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
