// The ONLY door between the renderers and Node. Both windows (the pill panel and the full
// CleanMyMac-style window) get this one narrow bridge — no Node, no fs, no child_process is
// ever exposed, only the named ipcRenderer channels below. Keeps the UI fully sandboxed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ram', {
	// ----- live push (main → renderer, every tick) -----
	onData: (cb) => ipcRenderer.on('data', (_e, d) => cb(d)),

	// ----- reads (renderer asks, main returns engine data) -----
	getStorage: () => ipcRenderer.invoke('storage:get'),
	scanJunk: () => ipcRenderer.invoke('junk:scan'),
	scanLarge: () => ipcRenderer.invoke('large:scan'),
	listApps: () => ipcRenderer.invoke('apps:list'),
	listLogin: () => ipcRenderer.invoke('login:list'),

	// ----- actions (each resolves AFTER the main-process confirm dialog) -----
	quit: (pid, name) => ipcRenderer.invoke('quit', { pid, name }),
	cleanJunk: (keys) => ipcRenderer.invoke('junk:clean', { keys }),
	trashLarge: (path) => ipcRenderer.invoke('large:trash', { path }),
	revealFile: (path) => ipcRenderer.invoke('large:reveal', { path }),
	uninstallApp: (path) => ipcRenderer.invoke('app:uninstall', { path }),
	setLoginItem: (name, enabled) => ipcRenderer.invoke('login:set', { name, enabled }),
});
