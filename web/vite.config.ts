import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// 开发时把 /api 和 /ws 转给本机后端（默认 8788）。
// 后端只接受同源请求：转发时把 Origin 改成后端自己的地址，否则写操作和 WebSocket 会被拒绝。
const BACKEND = process.env.BACKEND || 'http://127.0.0.1:8788'
const sameOrigin = (proxy: any) => {
  proxy.on('proxyReq', (req: any) => req.setHeader('origin', BACKEND))
  proxy.on('proxyReqWs', (req: any) => req.setHeader('origin', BACKEND))
}

// --mode demo：官网「在线体验」（/preview/ 下，没有后端，读录制的样本；见 src/lib/demo.ts）
export default defineConfig(({ mode }) => ({
  base: mode === 'demo' ? '/preview/' : '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true, configure: sameOrigin },
      '/ws': { target: BACKEND.replace(/^http/, 'ws'), ws: true, changeOrigin: true, configure: sameOrigin },
    },
  },
  build: { outDir: mode === 'demo' ? 'dist-demo' : 'dist', chunkSizeWarningLimit: 1200 },
}))
