/*---------------------------------------------------------------------------------------------
 *  RAM Guard — menu bar app (Electron main process).
 *
 *  Lives by the clock as a "42%" pill. Click it for a small panel: a memory bar, the macOS
 *  compressor bar (true pressure), and the apps eating the most RAM — each with a Quit button
 *  (confirm-guarded, because quitting an app is NOT "safe on disk" the way a Claude chat is).
 *--------------------------------------------------------------------------------------------*/

import { app, Tray, Menu, BrowserWindow, ipcMain, dialog, nativeImage, screen } from 'electron';
import * as path from 'path';
import { getSystemRam, listTopProcesses, RamInfo, Proc } from './ram';

const POLL_MS = 5000;   // ponytail: fixed 5s; add a settings panel only if someone asks
const CRIT_PCT = 88;    // pill shows a warning glyph at/above this

let tray: Tray;
let win: BrowserWindow;
let last: { ram?: RamInfo; procs: Proc[] } = { procs: [] };

function buildWindow(): void {
	win = new BrowserWindow({
		width: 360,
		height: 520,
		show: false,
		frame: false,
		resizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		webPreferences: {
			preload: path.join(__dirname, '..', 'preload.js'),
			contextIsolation: true,   // renderer can't touch Node directly...
			nodeIntegration: false,   // ...it only gets the narrow bridge in preload.js
			sandbox: true,
		},
	});
	void win.loadFile(path.join(__dirname, '..', 'index.html'));
	win.on('blur', () => win.hide()); // click away → tuck it back into the menu bar
}

function showPanel(): void {
	const tb = tray.getBounds();
	const wb = win.getBounds();
	const display = screen.getDisplayMatching(tb).workArea;
	let x = Math.round(tb.x + tb.width / 2 - wb.width / 2);
	x = Math.max(display.x + 4, Math.min(x, display.x + display.width - wb.width - 4));
	const y = Math.round(tb.y + tb.height + 4);
	win.setPosition(x, y, false);
	win.show();
	pushData();
}

function pushData(): void {
	if (win && !win.isDestroyed()) {
		win.webContents.send('data', { ram: last.ram, procs: last.procs });
	}
}

async function tick(): Promise<void> {
	const [ram, procs] = await Promise.all([getSystemRam(), listTopProcesses()]);
	last = { ram, procs };
	const glyph = ram.usedPct >= CRIT_PCT ? '! ' : '';
	tray.setTitle(`${glyph}${ram.usedPct.toFixed(0)}%`);
	if (win.isVisible()) { pushData(); }
}

// Quit a process — but make a normal person confirm first, because unlike a Claude session,
// a quit app loses anything unsaved. We never SIGKILL; SIGTERM lets the app shut down cleanly.
ipcMain.handle('quit', async (_e, { pid, name }: { pid: number; name: string }) => {
	const { response } = await dialog.showMessageBox(win, {
		type: 'warning',
		buttons: ['Cancel', 'Quit app'],
		defaultId: 0,
		cancelId: 0,
		message: `Quit ${name}?`,
		detail: 'Save your work first. Quitting closes the app and you may lose anything unsaved.',
	});
	if (response !== 1) { return { ok: false }; }
	try { process.kill(pid, 'SIGTERM'); return { ok: true }; }
	catch { return { ok: false }; }
});

app.whenReady().then(() => {
	if (process.platform === 'darwin') {
		app.dock?.hide();                    // menu bar only — no Dock icon
		app.setActivationPolicy('accessory');
	}

	tray = new Tray(nativeImage.createEmpty()); // text-only pill next to the clock
	tray.setTitle('…');
	tray.setToolTip('RAM Guard — click for the memory panel');
	tray.on('click', () => (win.isVisible() ? win.hide() : showPanel()));
	tray.on('right-click', () => tray.popUpContextMenu(
		Menu.buildFromTemplate([{ label: 'Quit RAM Guard', click: () => app.quit() }]),
	));

	buildWindow();
	void tick();
	setInterval(() => { void tick(); }, POLL_MS);
});

app.on('window-all-closed', () => { /* stay alive — it's a menu bar app */ });
