import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    // 这里不再把 GEMINI/飞书的密钥注入到前端。
    // 所有敏感信息都放到后端 server/.env（或线上平台环境变量）里。
    loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        // 本地开发：把 /api 代理到后端（默认 8787）
        proxy: {
          '/api': {
            target: 'http://localhost:8787',
            changeOrigin: true,
          }
        }
      },
      plugins: [react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
