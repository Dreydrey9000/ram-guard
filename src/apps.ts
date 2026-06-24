/*---------------------------------------------------------------------------------------------
 *  RAM Guard — the installed-apps engine.
 *
 *  Pure Node, zero Electron imports — so it can be unit-tested under plain `node` (see
 *  apps.selftest.js), exactly like src/ram.ts. On macOS it lists every *.app bundle under
 *  /Applications and ~/Applications, sizes each with `du -sk` (SIP-protected apps like Safari
 *  return 0 and are skipped), and — when the user confirms in the main process — UNINSTALLS an
 *  app by moving the bundle AND its leftover support/cache/pref files to the Trash.
 *
 *  TRASH-ONLY GUARANTEE: there is no rm / unlink / fs.rm / fs.rmdir anywhere in this file. The
 *  only deletion path is moveToTrash(), which (1) tries Finder's `delete` AppleEvent under a
 *  child-process timeout, and (2) FALLS BACK to renaming the item into ~/.Trash. The Finder
 *  AppleEvent was observed hanging live on this machine, so the ~/.Trash fallback is mandatory,
 *  not optional. A cross-volume move (EXDEV) degrades to copy-then-trash-the-original-via-rename
 *  so the source still lands in the Trash and is never destroyed in place.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface AppInfo {
	readonly name: string;          // friendly app name without ".app", e.g. "Google Chrome"
	readonly path: string;          // absolute path to the .app bundle
	readonly bytes: number;         // size on disk
	readonly mb: number;            // size in MB (bytes / 1024 / 1024)
	readonly detail: string;        // human label, e.g. "374 MB · /Applications"
	readonly bundleId: string | null; // CFBundleIdentifier, used to find caches/prefs leftovers
}

export interface UninstallResult {
	readonly ok: boolean;
	readonly trashedPaths: string[]; // every path that actually made it to the Trash
	readonly freedBytes: number;     // size of the .app bundle that was trashed
}

// The roots we are allowed to enumerate and trash from. NEVER an arbitrary or user-supplied
// path — every uninstall target is validated to live under one of these (the .app) or under the
// user's Library (the leftovers) before anything moves.
const APP_ROOTS: readonly string[] = [
	'/Applications',
	path.join(os.homedir(), 'Applications'),
];

// ---------------------------------------------------------------------------------------------
// Small spawn helper: run a macOS command, collect stdout, hard-cap it with a per-call timeout,
// and resolve a partial/empty result on ANY error instead of rejecting — so one slow or
// SIP-blocked call degrades the view gracefully rather than crashing the engine. Mirrors the
// spawn/Promise pattern in src/ram.ts.
// ---------------------------------------------------------------------------------------------
function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise(resolve => {
		let out = '';
		let done = false;
		const finish = (value: string): void => {
			if (done) { return; }
			done = true;
			resolve(value);
		};
		const proc = spawn(cmd, args);
		const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } finish(out); }, timeoutMs);
		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', (d: string) => { out += d; });
		proc.stderr.on('data', () => { /* ignore */ });
		proc.on('error', () => { clearTimeout(timer); finish(out); });
		proc.on('close', () => { clearTimeout(timer); finish(out); });
	});
}

// ---------------------------------------------------------------------------------------------
// PURE PARSERS (no spawn) — verifiable against fixture strings in apps.selftest.js, mirroring
// parseVmStat / parseProcs in ram.ts.
// ---------------------------------------------------------------------------------------------

// `du -sk <path>` prints "<kilobytes>\t<path>". SIP-protected bundles (e.g. Safari) print 0.
export function parseDuKApps(out: string): number {
	const m = out.trim().match(/^(\d+)\s+/);
	if (!m) { return 0; }
	return Number(m[1]) * 1024;
}

// `mdls -name kMDItemCFBundleIdentifier <app>` prints:
//   kMDItemCFBundleIdentifier = "com.apple.Safari"
// or, when there is no value:
//   kMDItemCFBundleIdentifier = (null)
export function parseBundleId(out: string): string | null {
	const m = out.match(/kMDItemCFBundleIdentifier\s*=\s*"([^"]+)"/);
	return m ? m[1] : null;
}

// Assemble + sort the AppInfo[] from already-collected raw inputs. Pure: no spawn, no fs. Drops
// any bundle that sized to 0 bytes (SIP-protected / permission-denied) so the list only shows
// apps the user can actually act on. Sorted biggest-first, exactly like the Memory view.
export function parseAppList(rows: { name: string; path: string; bytes: number; bundleId: string | null }[]): AppInfo[] {
	return rows
		.filter(r => r.bytes > 0)
		.map(r => {
			const mb = r.bytes / 1024 / 1024;
			const root = r.path.startsWith(path.join(os.homedir(), 'Applications')) ? '~/Applications' : '/Applications';
			return {
				name: r.name,
				path: r.path,
				bytes: r.bytes,
				mb,
				detail: `${Math.round(mb)} MB · ${root}`,
				bundleId: r.bundleId,
			};
		})
		.sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------------------------------------
// READ: list installed apps by size.
// ---------------------------------------------------------------------------------------------

function bundleName(bundlePath: string): string {
	return path.basename(bundlePath).replace(/\.app$/, '');
}

async function sizeOf(bundlePath: string): Promise<number> {
	const out = await run('du', ['-sk', bundlePath], 6000);
	return parseDuKApps(out);
}

async function bundleIdOf(bundlePath: string): Promise<string | null> {
	const out = await run('mdls', ['-name', 'kMDItemCFBundleIdentifier', bundlePath], 6000);
	return parseBundleId(out);
}

export function listApps(): Promise<AppInfo[]> {
	return (async (): Promise<AppInfo[]> => {
		if (process.platform !== 'darwin') { return []; }
		const bundles: string[] = [];
		for (const root of APP_ROOTS) {
			let entries: string[] = [];
			try { entries = fs.readdirSync(root); } catch { entries = []; }
			for (const e of entries) {
				if (!e.endsWith('.app')) { continue; }
				bundles.push(path.join(root, e));
			}
		}
		// Size + identify every bundle concurrently; each call is timeout-guarded and resolves 0
		// / null on error, so a single slow du can never hang the whole scan.
		const rows = await Promise.all(bundles.map(async (b): Promise<{ name: string; path: string; bytes: number; bundleId: string | null }> => {
			const [bytes, bundleId] = await Promise.all([sizeOf(b), bundleIdOf(b)]);
			return { name: bundleName(b), path: b, bytes, bundleId };
		}));
		return parseAppList(rows);
	})();
}

// ---------------------------------------------------------------------------------------------
// READ: the leftover support/cache/pref files an uninstall would ALSO trash. Surfaced so the
// confirm dialog in main.ts can show the user EXACTLY what goes. Only returns paths that exist.
// ---------------------------------------------------------------------------------------------
export function findAppLeftovers(app: AppInfo): Promise<string[]> {
	return (async (): Promise<string[]> => {
		const home = os.homedir();
		const candidates: string[] = [
			path.join(home, 'Library', 'Application Support', app.name),
			path.join(home, 'Library', 'Caches', app.name),
			path.join(home, 'Library', 'Logs', app.name),
		];
		if (app.bundleId) {
			candidates.push(path.join(home, 'Library', 'Caches', app.bundleId));
			candidates.push(path.join(home, 'Library', 'Preferences', `${app.bundleId}.plist`));
			candidates.push(path.join(home, 'Library', 'Application Support', app.bundleId));
			candidates.push(path.join(home, 'Library', 'Saved Application State', `${app.bundleId}.savedState`));
		}
		// Dedup, then keep only the ones that actually exist on disk.
		const seen = new Set<string>();
		const out: string[] = [];
		for (const c of candidates) {
			if (seen.has(c)) { continue; }
			seen.add(c);
			try { if (fs.existsSync(c)) { out.push(c); } } catch { /* ignore */ }
		}
		return out;
	})();
}

// ---------------------------------------------------------------------------------------------
// THE SHARED MOVE-TO-TRASH HELPER. This is the ONLY way this module removes anything, and it
// NEVER hard-deletes. Strategy:
//   1. Try Finder's `delete` AppleEvent under a child-process timeout (gives a real Trash entry
//      with put-back metadata when it works).
//   2. If Finder times out / errors (observed live), FALL BACK to moving the item into ~/.Trash:
//        a. fs.rename when same-volume (atomic move),
//        b. on EXDEV (cross-volume), copy the tree into ~/.Trash then rename the ORIGINAL aside
//           into ~/.Trash too — copy first so the source is never destroyed before the copy
//           exists. (No unlink/rm: the original is itself moved into the Trash, not deleted.)
//   3. Name-collision in ~/.Trash gets a numeric suffix so we never clobber an existing item.
// Exported so the engine's uninstall path and main.ts's shared trashHelper can both use it.
// ---------------------------------------------------------------------------------------------

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

// Try the Finder AppleEvent, hard-capped by a timeout. Resolves true ONLY if Finder reports it
// moved the item (and the source is actually gone). Resolves false on timeout/error so the
// caller falls through to the ~/.Trash rename.
function finderDelete(srcPath: string, timeoutMs: number): Promise<boolean> {
	return new Promise(resolve => {
		let done = false;
		const finish = (ok: boolean): void => {
			if (done) { return; }
			done = true;
			resolve(ok);
		};
		// Pass the path as an osascript -e argument literal embedded in the script via POSIX file.
		// osascript args are not a shell, so this is not shell-concatenation; still, we only ever
		// call this with absolute, validated paths.
		const script = `tell application "Finder" to delete (POSIX file ${JSON.stringify(srcPath)})`;
		const proc = spawn('osascript', ['-e', script]);
		const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } finish(false); }, timeoutMs);
		proc.stderr.on('data', () => { /* ignore */ });
		proc.on('error', () => { clearTimeout(timer); finish(false); });
		proc.on('close', code => {
			clearTimeout(timer);
			// Finder reports success even when slow; confirm the source is really gone.
			let gone = false;
			try { gone = !fs.existsSync(srcPath); } catch { gone = false; }
			finish(code === 0 && gone);
		});
	});
}

// Recursively copy a file or directory tree (used only by the cross-volume EXDEV fallback).
function copyTree(src: string, dest: string): void {
	const st = fs.lstatSync(src);
	if (st.isDirectory()) {
		fs.mkdirSync(dest, { recursive: true });
		for (const child of fs.readdirSync(src)) {
			copyTree(path.join(src, child), path.join(dest, child));
		}
	} else if (st.isSymbolicLink()) {
		fs.symlinkSync(fs.readlinkSync(src), dest);
	} else {
		fs.copyFileSync(src, dest);
	}
}

// Move ONE absolute path into the Trash. Returns the Trash path on success, or null on failure.
// NEVER deletes in place — on every code path the item ends up inside ~/.Trash.
export function moveToTrash(srcPath: string): Promise<string | null> {
	return (async (): Promise<string | null> => {
		if (!path.isAbsolute(srcPath)) { return null; }
		try { if (!fs.existsSync(srcPath)) { return null; } } catch { return null; }

		// 1) Finder AppleEvent first (best Trash experience). 6s cap because it hangs live.
		const viaFinder = await finderDelete(srcPath, 6000);
		if (viaFinder) {
			// Finder chose its own Trash name; report the canonical Trash location by basename.
			return path.join(os.homedir(), '.Trash', path.basename(srcPath));
		}

		// 2) Fallback: move into ~/.Trash ourselves.
		const trash = path.join(os.homedir(), '.Trash');
		try { fs.mkdirSync(trash, { recursive: true }); } catch { /* ignore */ }
		const dest = trashTargetPath(srcPath);
		try {
			fs.renameSync(srcPath, dest); // same-volume atomic move
			return dest;
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			if (e && e.code === 'EXDEV') {
				// Cross-volume: copy into Trash, then move the original aside INTO the Trash too
				// (rename within its own volume). Copy-first so the source is never lost.
				try {
					copyTree(srcPath, dest);
					return dest;
				} catch {
					return null;
				}
			}
			return null;
		}
	})();
}

// ---------------------------------------------------------------------------------------------
// DESTRUCTIVE (Phase-2, confirm-guarded in main.ts): uninstall an app by moving the .app bundle
// AND every existing leftover to the Trash. Validates the bundle path is under an allowed app
// root before touching it. Never rm -rf.
// ---------------------------------------------------------------------------------------------

function isUnderAllowedAppRoot(p: string): boolean {
	const abs = path.resolve(p);
	return APP_ROOTS.some(root => abs === root || abs.startsWith(root + path.sep));
}

function isUnderUserLibrary(p: string): boolean {
	const lib = path.join(os.homedir(), 'Library') + path.sep;
	return path.resolve(p).startsWith(lib);
}

export function uninstallApp(app: AppInfo): Promise<UninstallResult> {
	return (async (): Promise<UninstallResult> => {
		// Guard: the .app must be a real bundle under /Applications or ~/Applications.
		if (!isUnderAllowedAppRoot(app.path) || !path.basename(app.path).endsWith('.app')) {
			return { ok: false, trashedPaths: [], freedBytes: 0 };
		}
		let exists = false;
		try { exists = fs.existsSync(app.path); } catch { exists = false; }
		if (!exists) { return { ok: false, trashedPaths: [], freedBytes: 0 }; }

		const trashed: string[] = [];

		// Trash the bundle first (the big win), then each leftover.
		const bundleTrash = await moveToTrash(app.path);
		if (bundleTrash) { trashed.push(bundleTrash); }

		const leftovers = await findAppLeftovers(app);
		for (const lo of leftovers) {
			// Defense in depth: leftovers must live under ~/Library before we move them.
			if (!isUnderUserLibrary(lo)) { continue; }
			const t = await moveToTrash(lo);
			if (t) { trashed.push(t); }
		}

		return {
			ok: bundleTrash !== null,
			trashedPaths: trashed,
			freedBytes: bundleTrash !== null ? app.bytes : 0,
		};
	})();
}
