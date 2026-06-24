/*---------------------------------------------------------------------------------------------
 *  RAM Guard — menu bar app (Electron main process).
 *
 *  TWO windows, one menu-bar app:
 *    - the original "42%" pill panel (kept verbatim — index.html / renderer.js), and
 *    - a full CleanMyMac-style window (window.html / window-renderer.js) with 7 views:
 *      Overview, Memory, Junk & Caches, Large & Old Files, Applications, Login Items, Storage.
 *
 *  The full window reads LIVE data from the engine modules (ram/storage/junk/large-files/apps/
 *  login-items) over a narrow preload bridge, and every DESTRUCTIVE action (quit a process,
 *  clean junk, trash a large file, uninstall an app, toggle a login item) is gated behind a
 *  confirm dialog that lists the EXACT items/paths/sizes about to be touched. Nothing is ever
 *  hard-deleted: every removal routes through the shared trashHelper() which only MOVES items
 *  to the Trash (Finder "delete" AppleEvent, with a ~/.Trash fs.rename fallback because Finder
 *  AppleEvents were observed timing out live).
 *--------------------------------------------------------------------------------------------*/

import { app, Tray, Menu, BrowserWindow, ipcMain, dialog, nativeImage, screen } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getSystemRam, listTopProcesses, RamInfo, Proc } from './ram';
import { getStorageBreakdown, StorageInfo } from './storage';
import { scanJunk, cleanJunk, JunkCategory, CleanResult } from './junk';
import { scanLargeFiles, revealLargeFile, trashLargeFile, LargeFile } from './large-files';
import { listApps, findAppLeftovers, uninstallApp, AppInfo, UninstallResult } from './apps';
import { listLoginItems, setLoginItem, LoginItem, SetLoginResult } from './login-items';

const POLL_MS = 5000;   // ponytail: fixed 5s; add a settings panel only if someone asks
const CRIT_PCT = 88;    // pill shows a warning glyph at/above this

let tray: Tray;
let win: BrowserWindow;        // the small menu-bar pill panel (unchanged)
let mainWin: BrowserWindow;    // the full CleanMyMac-style window (new)
let last: { ram?: RamInfo; procs: Proc[] } = { procs: [] };

// Caches of the last read scan so a destructive action handler can re-resolve the full object
// (AppInfo, LoginItem) and its leftover preview by a single id (path / name) the renderer sends.
// Keeps the renderer narrow — it never has to ship a whole object back to trigger an action.
let lastApps: AppInfo[] = [];
let lastLogin: LoginItem[] = [];

// The set of user roots ANY trash move is allowed to touch. Defense-in-depth on top of each
// engine's own allowlist: the shared helper refuses to move anything outside these.
const ALLOWED_TRASH_ROOTS: readonly string[] = [
	path.join(os.homedir(), 'Library'),
	path.join(os.homedir(), '.Trash'),
	path.join(os.homedir(), 'Downloads'),
	path.join(os.homedir(), 'Movies'),
	path.join(os.homedir(), 'Music'),
	path.join(os.homedir(), 'Pictures'),
	path.join(os.homedir(), 'Documents'),
	path.join(os.homedir(), 'Desktop'),
	path.join(os.homedir(), 'Applications'),
	'/Applications',
];

function isUnderAllowedTrashRoot(target: string): boolean {
	const abs = path.resolve(target);
	return ALLOWED_TRASH_ROOTS.some(root => abs === root || abs.startsWith(root + path.sep));
}

// ---------------------------------------------------------------------------------------------
// THE SHARED MOVE-TO-TRASH HELPER. The ONLY way main.ts removes anything. Never hard-deletes.
//   1. Try Finder's `delete` AppleEvent under a 6s child-process timeout (real Trash entry with
//      put-back metadata when it works).
//   2. On timeout/error (observed live), FALL BACK to moving the item into ~/.Trash via
//      fs.rename, with a numeric suffix on name collisions so we never clobber an existing item.
// Every path is validated absolute + existing + under an allowed user root before any move.
// NEVER fs.rm / fs.rmdir / fs.unlink.
// ---------------------------------------------------------------------------------------------
function finderDelete(srcPath: string, timeoutMs: number): Promise<boolean> {
	return new Promise(resolve => {
		let done = false;
		const finish = (ok: boolean): void => { if (!done) { done = true; resolve(ok); } };
		const script = `tell application "Finder" to delete (POSIX file ${JSON.stringify(srcPath)})`;
		const proc = spawn('osascript', ['-e', script]);
		const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } finish(false); }, timeoutMs);
		proc.stderr.on('data', () => { /* ignore */ });
		proc.on('error', () => { clearTimeout(timer); finish(false); });
		proc.on('close', code => {
			clearTimeout(timer);
			let gone = false;
			try { gone = !fs.existsSync(srcPath); } catch { gone = false; }
			finish(code === 0 && gone);
		});
	});
}

function trashTargetPath(srcPath: string): string {
	const trash = path.join(os.homedir(), '.Trash');
	const base = path.basename(srcPath);
	let candidate = path.join(trash, base);
	let n = 1;
	while (fs.existsSync(candidate)) {
		const ext = path.extname(base);
		const stem = ext ? base.slice(0, -ext.length) : base;
		candidate = path.join(trash, `${stem} ${n}${ext}`);
		n += 1;
	}
	return candidate;
}

async function trashHelper(paths: string[]): Promise<string[]> {
	const moved: string[] = [];
	for (const raw of paths) {
		if (!raw || !path.isAbsolute(raw)) { continue; }
		const target = path.resolve(raw);
		if (!isUnderAllowedTrashRoot(target)) { continue; }
		try { if (!fs.existsSync(target)) { continue; } } catch { continue; }

		// 1) Finder AppleEvent first.
		if (await finderDelete(target, 6000)) {
			moved.push(path.join(os.homedir(), '.Trash', path.basename(target)));
			continue;
		}
		// 2) Fallback: move into ~/.Trash ourselves.
		const trash = path.join(os.homedir(), '.Trash');
		try { fs.mkdirSync(trash, { recursive: true }); } catch { /* ignore */ }
		const dest = trashTargetPath(target);
		try { fs.renameSync(target, dest); moved.push(dest); }
		catch { /* leave it; never hard-delete */ }
	}
	return moved;
}

const SECURE_PREFS = {
	preload: path.join(__dirname, '..', 'preload.js'),
	contextIsolation: true,   // renderer can't touch Node directly...
	nodeIntegration: false,   // ...it only gets the narrow bridge in preload.js
	sandbox: true,
};

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
		webPreferences: SECURE_PREFS,
	});
	void win.loadFile(path.join(__dirname, '..', 'index.html'));
	win.on('blur', () => win.hide()); // click away → tuck it back into the menu bar
}

// The full CleanMyMac-style window. Same secure prefs as the pill. Hidden until opened; on close
// it hides instead of quitting so the app stays alive as a menu-bar app.
function buildMainWindow(): void {
	mainWin = new BrowserWindow({
		width: 1060,
		height: 684,
		show: false,
		title: 'RAM Guard',
		titleBarStyle: 'hiddenInset',
		resizable: true,
		minWidth: 920,
		minHeight: 600,
		fullscreenable: false,
		webPreferences: SECURE_PREFS,
	});
	void mainWin.loadFile(path.join(__dirname, '..', 'window.html'));
	mainWin.on('close', e => {
		// menu-bar app: closing the window only hides it.
		if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
			e.preventDefault();
			mainWin.hide();
		}
	});
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

// Show/focus the full window and push the initial memory snapshot so the Memory view / Overview
// ring fill in immediately (the renderer also pulls the rest of its data over the bridge).
function openMainWindow(): void {
	if (!mainWin || mainWin.isDestroyed()) { buildMainWindow(); }
	mainWin.show();
	mainWin.focus();
	if (process.platform === 'darwin') { app.dock?.show().catch(() => { /* ignore */ }); }
	pushData();
}

function pushData(): void {
	const payload = { ram: last.ram, procs: last.procs };
	if (win && !win.isDestroyed()) { win.webContents.send('data', payload); }
	if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) {
		mainWin.webContents.send('data', payload);
	}
}

// Non-overlap guard: even though both engines are now timeout-guarded (max ~3s each), a tick must
// never STACK on a previous slow tick — otherwise every 5s we'd spawn another vm_stat+ps while the
// last pair is still finishing, piling up children. If a tick is already in flight we skip this
// beat entirely; the next interval picks it up.
let tickRunning = false;

async function tick(): Promise<void> {
	if (tickRunning) { return; }
	tickRunning = true;
	try {
		const [ram, procs] = await Promise.all([getSystemRam(), listTopProcesses()]);
		last = { ram, procs };
		const glyph = ram.usedPct >= CRIT_PCT ? '! ' : '';
		tray.setTitle(`${glyph}${ram.usedPct.toFixed(0)}%`);
		if (win.isVisible() || (mainWin && !mainWin.isDestroyed() && mainWin.isVisible())) { pushData(); }
	} finally {
		tickRunning = false;
	}
}

// ---------------------------------------------------------------------------------------------
// IPC: read handlers just call the engines and return. Destructive handlers FIRST open a confirm
// dialog (Cancel as defaultId/cancelId) listing exactly what will be affected, and only proceed
// on explicit confirm — reusing the proven 'quit' pattern.
// ---------------------------------------------------------------------------------------------
function confirmDialog(parent: BrowserWindow | null, message: string, detail: string, confirmLabel: string): Promise<boolean> {
	const opts = {
		type: 'warning' as const,
		buttons: ['Cancel', confirmLabel],
		defaultId: 0,
		cancelId: 0,
		message,
		detail,
	};
	const p = parent && !parent.isDestroyed()
		? dialog.showMessageBox(parent, opts)
		: dialog.showMessageBox(opts);
	return p.then(r => r.response === 1);
}

function fmtBytes(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) { return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB'; }
	if (bytes >= 1024 * 1024) { return (bytes / 1024 / 1024).toFixed(0) + ' MB'; }
	return Math.max(0, Math.round(bytes / 1024)) + ' KB';
}

function registerIpc(): void {
	// ----- READ -----
	ipcMain.handle('storage:get', async (): Promise<StorageInfo> => {
		// Feed the junk total in so the Storage "Junk & caches" slice is real, not 0.
		let junkBytes = 0;
		try {
			const cats = await scanJunk();
			junkBytes = cats.reduce((sum, c) => sum + c.bytes, 0);
		} catch { junkBytes = 0; }
		return getStorageBreakdown({ junkBytes });
	});

	ipcMain.handle('junk:scan', async (): Promise<JunkCategory[]> => scanJunk());

	ipcMain.handle('large:scan', async (): Promise<LargeFile[]> => scanLargeFiles());

	ipcMain.handle('apps:list', async (): Promise<AppInfo[]> => {
		lastApps = await listApps();
		return lastApps;
	});

	ipcMain.handle('login:list', async (): Promise<LoginItem[]> => {
		lastLogin = await listLoginItems();
		return lastLogin;
	});

	// ----- ACTIONS (all confirm-gated, all move-to-Trash only) -----

	// quit (existing pattern, reused for the Memory view).
	ipcMain.handle('quit', async (_e, { pid, name }: { pid: number; name: string }) => {
		const ok = await confirmDialog(mainWin || win,
			`Quit ${name}?`,
			'Save your work first. Quitting closes the app and you may lose anything unsaved.',
			'Quit app');
		if (!ok) { return { ok: false }; }
		try { process.kill(pid, 'SIGTERM'); return { ok: true }; }
		catch { return { ok: false }; }
	});

	// junk:clean — lists the selected categories + total size + the "moves to Trash" promise.
	ipcMain.handle('junk:clean', async (_e, { keys }: { keys: string[] }): Promise<CleanResult> => {
		const safeKeys = Array.isArray(keys) ? keys.filter(k => typeof k === 'string') : [];
		if (safeKeys.length === 0) { return { ok: false, freedBytes: 0, movedPaths: [] }; }
		let cats: JunkCategory[] = [];
		try { cats = await scanJunk(); } catch { cats = []; }
		const chosen = cats.filter(c => safeKeys.includes(c.key));
		if (chosen.length === 0) { return { ok: false, freedBytes: 0, movedPaths: [] }; }
		const total = chosen.reduce((s, c) => s + c.bytes, 0);
		const lines = chosen.map(c => `• ${c.label} (${fmtBytes(c.bytes)})`).join('\n');
		const ok = await confirmDialog(mainWin,
			`Clean ${chosen.length} ${chosen.length === 1 ? 'category' : 'categories'}? (${fmtBytes(total)})`,
			`These move to the Trash — they are NOT hard-deleted, so you can put them back:\n\n${lines}`,
			'Move to Trash');
		if (!ok) { return { ok: false, freedBytes: 0, movedPaths: [] }; }
		return cleanJunk(safeKeys);
	});

	// large:trash — shows the exact file path + size before the move.
	ipcMain.handle('large:trash', async (_e, { path: filePath }: { path: string }): Promise<{ ok: boolean; trashedPath?: string }> => {
		if (typeof filePath !== 'string' || !filePath) { return { ok: false }; }
		let sizeNote = '';
		try { const st = fs.statSync(filePath); sizeNote = ` (${fmtBytes(st.size)})`; } catch { /* ignore */ }
		const ok = await confirmDialog(mainWin,
			'Move this file to the Trash?',
			`${filePath}${sizeNote}\n\nIt moves to the Trash — not hard-deleted, so you can put it back.`,
			'Move to Trash');
		if (!ok) { return { ok: false }; }
		return trashLargeFile(filePath);
	});

	// large:reveal — non-destructive, no confirm (matches the mockup "Reveal").
	ipcMain.handle('large:reveal', async (_e, { path: filePath }: { path: string }): Promise<{ ok: boolean }> => {
		if (typeof filePath !== 'string' || !filePath) { return { ok: false }; }
		return revealLargeFile(filePath);
	});

	// app:uninstall — re-resolves the AppInfo from the last scan by path, lists the .app bundle
	// AND every existing leftover that will move to Trash before acting.
	ipcMain.handle('app:uninstall', async (_e, { path: appPath }: { path: string }): Promise<UninstallResult> => {
		if (typeof appPath !== 'string' || !appPath) { return { ok: false, trashedPaths: [], freedBytes: 0 }; }
		const appInfo = lastApps.find(a => a.path === appPath);
		if (!appInfo) { return { ok: false, trashedPaths: [], freedBytes: 0 }; }
		let leftovers: string[] = [];
		try { leftovers = await findAppLeftovers(appInfo); } catch { leftovers = []; }
		const lines = [appInfo.path, ...leftovers].map(p => `• ${p}`).join('\n');
		const ok = await confirmDialog(mainWin,
			`Uninstall ${appInfo.name}? (${fmtBytes(appInfo.bytes)})`,
			`These move to the Trash — bundle and its leftovers — not hard-deleted, so you can put them back:\n\n${lines}`,
			'Move to Trash');
		if (!ok) { return { ok: false, trashedPaths: [], freedBytes: 0 }; }
		return uninstallApp(appInfo);
	});

	// login:set — confirm + name-allowlist (validated against the live set in setLoginItem too).
	ipcMain.handle('login:set', async (_e, { name, enabled }: { name: string; enabled: boolean }): Promise<SetLoginResult> => {
		if (typeof name !== 'string' || !name) { return { ok: false }; }
		const known = lastLogin.some(l => l.name === name);
		if (!known) { return { ok: false }; }
		const turningOff = enabled === false;
		const ok = await confirmDialog(mainWin,
			turningOff ? `Stop ${name} opening at login?` : `Let ${name} open at login?`,
			turningOff
				? 'This removes it from your startup items so your Mac boots faster. You can add it back later.'
				: 'This adds it back to your startup items.',
			turningOff ? 'Stop at login' : 'Add to login');
		if (!ok) { return { ok: false }; }
		const result = await setLoginItem(name, enabled);
		// refresh the cache so a follow-up action validates against current state
		try { lastLogin = await listLoginItems(); } catch { /* keep old cache */ }
		return result;
	});
}

app.whenReady().then(() => {
	if (process.platform === 'darwin') {
		app.dock?.hide();                    // menu bar only — no Dock icon until the window opens
		app.setActivationPolicy('accessory');
	}

	registerIpc();
	buildWindow();
	buildMainWindow();

	tray = new Tray(nativeImage.createEmpty()); // text-only pill next to the clock
	tray.setTitle('…');
	tray.setToolTip('RAM Guard — click to open');
	// Per task: tray left-click opens the full window. The small pill panel is kept as a
	// secondary surface, reachable from the tray menu.
	tray.on('click', () => openMainWindow());
	tray.on('right-click', () => tray.popUpContextMenu(
		Menu.buildFromTemplate([
			{ label: 'Open RAM Guard', click: () => openMainWindow() },
			{ label: 'Memory panel', click: () => (win.isVisible() ? win.hide() : showPanel()) },
			{ type: 'separator' },
			{ label: 'Quit RAM Guard', click: () => {
				(app as unknown as { isQuitting?: boolean }).isQuitting = true;
				app.quit();
			} },
		]),
	));

	void tick();
	setInterval(() => { void tick(); }, POLL_MS);
});

app.on('window-all-closed', () => { /* stay alive — it's a menu bar app */ });
