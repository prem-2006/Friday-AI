import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './editor.css';
import '../friday/client/nebula.css';
import { watchSystemTheme } from './theme';
watchSystemTheme();
const root = createRoot(document.getElementById('root')!);
const show = (page: React.ReactNode) =>
  root.render(<React.StrictMode>{page}</React.StrictMode>);
// FRIDAY: the desktop's small windows load only their own code, not the whole
// app (its editor, chat and their libraries), so they show a second or two
// after Friday starts instead of after every module is ready.
const pages: Record<string, () => Promise<React.ReactNode>> = {
  '#/notch': () =>
    import('../friday/client/stage/NotchWindow').then(({ NotchWindow }) => (
      <NotchWindow />
    )),
  '#/toast': () =>
    import('../friday/client/stage/ActivityToast').then(({ ActivityToast }) => (
      <ActivityToast />
    )),
  '#/overlay': () =>
    import('../friday/client/stage/ScreenOverlay').then(({ ScreenOverlay }) => (
      <ScreenOverlay />
    )),
};
void (
  pages[location.hash] ?? (() => import('./App').then(({ App }) => <App />))
)().then(show);
