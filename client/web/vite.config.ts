import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: {
    react: path.resolve(__dirname, '../desktop/frontend/node_modules/react'),
    'react-dom': path.resolve(__dirname, '../desktop/frontend/node_modules/react-dom'),
    motion: path.resolve(__dirname, '../desktop/frontend/node_modules/motion'),
  } },
  server: {
    fs: { allow: [path.resolve(__dirname, '..')] },
    proxy: { '/api': { target: 'http://127.0.0.1:8765', ws: true } },
  },
  build: { outDir: '../../cmd/lake/web_dist', emptyOutDir: true },
})
