import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { darkTheme } from './src/build/dark-theme';
export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [darkTheme()] } },
  build: { outDir: 'dist/client' },
  // FRIDAY: only the app's page; friday/services holds hundreds of unrelated HTML files.
  optimizeDeps: { entries: ['index.html'] },
  server: {
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4310' },
    // FRIDAY: the Python services' packages, data and Chrome profile change
    // constantly while they run; watching them reloads the page mid-task.
    watch: { ignored: ['**/friday/services/**', '**/data/**'] },
  },
});
