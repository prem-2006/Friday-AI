// Friday's notch page can ask the shell to take clicks while the pill needs
// them (an approval), to open Friday's main page, and to hide or show the notch
// (Ctrl + Caps Lock).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fridayDesktop', {
  setInteractive: (on) => ipcRenderer.send('friday:interactive', !!on),
  open: (hash) => ipcRenderer.send('friday:open', hash),
  toggle: () => ipcRenderer.send('friday:toggle'),
});
