import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(() => ({
  // Both dev (Vite on :3000) and prod (Fastify on :3001) serve from the
  // origin root — absolute paths work in both.
  base: '/',

  plugins: [react()],

  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },

  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          motion: ['framer-motion'],
          data: ['dexie', 'dexie-react-hooks', 'minisearch'],
          sanitize: ['dompurify'],
        },
      },
    },
  },
}))
