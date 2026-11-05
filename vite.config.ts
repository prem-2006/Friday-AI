import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { darkTheme } from './src/build/dark-theme';
// FRIDAY: folders at the project root that hold no page code. friday/ alone has
// over 40,000 files (the services, browser agent and Hermes); watching them
// made Vite spend its first ~30 seconds scanning, answering every request
// slowly. Matched from the root, so src/friday/ is still watched.
const slashes = (path: string) => path.replace(/\\/g, '/').toLowerCase();
const unwatched = ['friday/', 'data/', 'dist/', 'graphify-out/'].map((dir) =>
  slashes(fileURLToPath(new URL(dir, import.meta.url))),
);
const isUnwatched = (file: string) => {
  const path = slashes(file);
  return unwatched.some((dir) => path.startsWith(dir) || `${path}/` === dir);
};

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
    watch: { ignored: [isUnwatched] },
  },
});
