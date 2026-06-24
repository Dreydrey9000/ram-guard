// The ONLY door between the panel (renderer) and Node. The renderer can read live data and
// ask to quit a process by pid — nothing else. Keeps the UI sandboxed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ram', {
	onData: (cb) => ipcRenderer.on('data', (_e, d) => cb(d)),
	quit: (pid, name) => ipcRenderer.invoke('quit', { pid, name }),
});
