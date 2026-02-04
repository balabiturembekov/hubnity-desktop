import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  // CRITICAL FIX: Используем относительные пути для production build (Tauri)
  // В Tauri используется протокол tauri://localhost, абсолютные пути не работают
  // Для dev режима используем абсолютные пути, для production - относительные
  const isProduction = mode === 'production';
  
  return {
  plugins: [react()],
  
  // CRITICAL FIX: Всегда используем относительные пути для Tauri
  // Tauri использует протокол tauri://localhost, абсолютные пути не работают
  base: './',
  
  // Vitest configuration
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },

  build: {
    rollupOptions: {
      input: {
        main: './index.html',
        idle: './idle.html',
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  };
});
