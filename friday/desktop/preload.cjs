// Friday's notch page can ask the shell for two things: take clicks while the
// pill needs them (an approval), and open Friday's main page in the browser.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fridayDesktop', {
  setInteractive: (on) => ipcRenderer.send('friday:interactive', !!on),
  open: (hash) => ipcRenderer.send('friday:open', hash),
});
