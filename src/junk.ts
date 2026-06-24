/*---------------------------------------------------------------------------------------------
 *  RAM Guard — the junk engine.
 *
 *  Pure Node, zero Electron imports — so it can be unit-tested under plain `node` (see
 *  junk.selftest.js). Sizes a FIXED ALLOWLIST of safe-to-clear roots (user caches, logs,
 *  browser caches, Trash) with `du -sk`, and — when the user explicitly confirms in the main
 *  process — MOVES the contents of selected roots to the Trash.
 *
 *  TRASH-ONLY (non-negotiable): cleaning NEVER hard-deletes. There is ZERO use of
 *  rm/unlink/fs.rm/fs.rmdir on any user path. The single move-to-Trash helper tries
 *  `osascript` Finder 'delete' first, and because Finder AppleEvents were observed timing
 *  out live, FALLS BACK to moving each item into ~/.Trash via fs.rename (with a name-collision
 *  suffix). Every path is validated absolute + existing + under an allowed root before it moves.
 *
 *  ONE EXCEPTION — the 'trash' category. You cannot reclaim space by "moving items to the Trash"
 *  when they are ALREADY in the Trash (that only renames them within ~/.Trash and frees nothing).
 *  So the 'trash' category EMPTIES the Trash via `osascript` Finder 'empty the trash' and credits
 *  only the bytes that actually left (re-measured before/after). To stay unit-testable without
 *  touching the real Finder, cleanJunk takes an optional injected emptier the self-test overrides
 *  with a sandbox-only implementation.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface JunkCategory {
	readonly key: 'userCaches' | 'systemLogs' | 'browserData' | 'trash';
	readonly label: string;
	readonly detail: string;
	readonly bytes: number;
	readonly mb: number;
	readonly selected: boolean;
	readonly paths: string[];   // the EXACT directories a later clean would target
}

export interface CleanResult {
	readonly ok: boolean;
	readonly freedBytes: number;
	readonly movedPaths: string[];
}

const HOME = os.homedir();

// The ONLY roots this engine is ever allowed to size or clean. Never an arbitrary or
// user-supplied path. Browser caches live as subfolders under ~/Library/Caches, so they are
// covered by the same allowlist when we validate a path is "under an allowed root".
const ALLOWED_ROOTS: readonly string[] = [
	path.join(HOME, 'Library', 'Caches'),
	path.join(HOME, 'Library', 'Logs'),
	path.join(HOME, '.Trash'),
];

const TRASH_DIR = path.join(HOME, '.Trash');

// Each junk category maps to exactly one root directory whose CONTENTS a clean would trash.
// Browser cache folders are the well-known Safari/Chrome subfolders under ~/Library/Caches —
// du-sizing the parent root is the honest total, and the browser row surfaces the specific
// subfolders so the confirm dialog can show precisely what goes.
interface CategorySpec {
	readonly key: JunkCategory['key'];
	readonly label: string;
	readonly detail: string;
	readonly root: string;            // the directory whose contents get trashed
	readonly sizeRoots: string[];     // directories to du-sum for the displayed size
	readonly defaultSelected: boolean;
}

const CATEGORY_SPECS: readonly CategorySpec[] = [
	{
		key: 'userCaches',
		label: 'User Caches',
		detail: '~/Library/Caches',
		root: path.join(HOME, 'Library', 'Caches'),
		sizeRoots: [path.join(HOME, 'Library', 'Caches')],
		defaultSelected: true,
	},
	{
		key: 'systemLogs',
		label: 'Logs',
		detail: '~/Library/Logs',
		root: path.join(HOME, 'Library', 'Logs'),
		sizeRoots: [path.join(HOME, 'Library', 'Logs')],
		defaultSelected: true,
	},
	{
		// Browser caches are a SUBSET of ~/Library/Caches — the well-known Safari/Chrome
		// cache subfolders. Cleaning targets those subfolders specifically (so we never trash
		// the whole Caches root twice), and the size is the du-sum of just those subfolders.
		key: 'browserData',
		label: 'Browser Data',
		detail: 'Safari & Chrome caches',
		root: path.join(HOME, 'Library', 'Caches'),
		sizeRoots: [
			path.join(HOME, 'Library', 'Caches', 'com.apple.Safari'),
			path.join(HOME, 'Library', 'Caches', 'com.google.Chrome'),
			path.join(HOME, 'Library', 'Caches', 'Google', 'Chrome'),
		],
		// broken-prefs style entry — defaults OFF in the mockup.
		defaultSelected: false,
	},
	{
		key: 'trash',
		label: 'Trash',
		detail: '~/.Trash',
		root: path.join(HOME, '.Trash'),
		sizeRoots: [path.join(HOME, '.Trash')],
		defaultSelected: false,
	},
];

// ---------------------------------------------------------------------------------------------
// Pure parse helpers (no spawn) — verified against fixture strings in the self-test, mirroring
// the parseVmStat / parseProcs pattern in ram.ts.
// ---------------------------------------------------------------------------------------------

// `du -sk <dir>` prints "<kilobytes>\t<path>" (one or more lines if multiple roots were passed).
// We sum the kilobyte column across every line and convert to bytes. A line that doesn't start
// with a number (a stderr leak, a "Permission denied" notice) is ignored, so a partially
// blocked du still yields the bytes it could measure instead of throwing.
export function parseDuK(out: string): number {
	let kb = 0;
	for (const line of out.split('\n')) {
		const m = line.trim().match(/^(\d+)\s+/);
		if (!m) { continue; }
		kb += Number(m[1]);
	}
	return kb * 1024;
}

// ---------------------------------------------------------------------------------------------
// Sizing (read-only) — every `du` is timeout-guarded and resolves partial/0 on error so one
// slow or SIP-blocked directory degrades the view gracefully instead of crashing.
// ---------------------------------------------------------------------------------------------

const DU_TIMEOUT_MS = 6000;

// Runs `du -sk` over a set of directories and resolves the summed bytes. NEVER rejects: on
// spawn error, non-zero exit, or timeout it resolves the bytes parsed so far (0 if none).
// Skips paths that don't exist so a missing browser-cache folder counts as 0, not an error.
function duBytes(dirs: string[]): Promise<number> {
	return new Promise(resolve => {
		const existing = dirs.filter(d => existsSafe(d));
		if (existing.length === 0) { resolve(0); return; }
		const proc = spawn('du', ['-sk', ...existing]);
		proc.stdout.setEncoding('utf8');
		let out = '';
		let done = false;
		const finish = (): void => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			try { proc.kill('SIGKILL'); } catch { /* already gone */ }
			resolve(parseDuK(out));
		};
		const timer = setTimeout(finish, DU_TIMEOUT_MS);
		proc.stdout.on('data', (d: string) => { out += d; });
		proc.stderr.on('data', () => { /* ignore "Permission denied" noise */ });
		proc.on('error', finish);
		proc.on('close', finish);
	});
}

// Sizes the FIXED allowlist of safe-to-clear roots and returns one row per category. Each row
// carries the EXACT paths a later clean would target, so the confirm dialog can show them.
export function scanJunk(): Promise<JunkCategory[]> {
	return Promise.all(CATEGORY_SPECS.map(async (spec): Promise<JunkCategory> => {
		const bytes = await duBytes(spec.sizeRoots);
		const cleanTargets = spec.key === 'browserData'
			? spec.sizeRoots.filter(d => existsSafe(d))   // browser: trash just the known subfolders
			: [spec.root];                                 // others: trash the root's contents
		return {
			key: spec.key,
			label: spec.label,
			detail: spec.detail,
			bytes,
			mb: bytes / 1024 / 1024,
			selected: spec.defaultSelected,
			paths: cleanTargets,
		};
	}));
}

// ---------------------------------------------------------------------------------------------
// Move-to-Trash (DESTRUCTIVE, confirm-gated in main.ts) — the single shared helper.
// ---------------------------------------------------------------------------------------------

const OSASCRIPT_TIMEOUT_MS = 5000;

// True only if `target` is an absolute, existing path that sits under one of the allowed roots
// (or IS an allowed root). This is the gate that stops any arbitrary or user-supplied path from
// ever reaching the move logic. `~/.Trash` itself is excluded as a move TARGET source check
// only via the per-item logic below — emptying Trash means moving its CONTENTS, never the
// .Trash folder itself.
export function isUnderAllowedRoot(target: string): boolean {
	if (!path.isAbsolute(target)) { return false; }
	const resolved = path.resolve(target);
	return ALLOWED_ROOTS.some(root => {
		const r = path.resolve(root);
		return resolved === r || resolved.startsWith(r + path.sep);
	});
}

function existsSafe(p: string): boolean {
	try { return fs.existsSync(p); } catch { return false; }
}

// Picks a non-colliding name inside ~/.Trash. If "foo" already exists there, returns
// "foo 2", "foo 3", … — mirroring how Finder de-duplicates trashed items.
function trashTargetFor(name: string): string {
	let candidate = path.join(TRASH_DIR, name);
	if (!existsSafe(candidate)) { return candidate; }
	const ext = path.extname(name);
	const base = path.basename(name, ext);
	for (let i = 2; i < 10000; i++) {
		candidate = path.join(TRASH_DIR, `${base} ${i}${ext}`);
		if (!existsSafe(candidate)) { return candidate; }
	}
	// Astronomically unlikely fallthrough — timestamp guarantees uniqueness.
	return path.join(TRASH_DIR, `${base} ${Date.now()}${ext}`);
}

// Moves a SINGLE validated item into ~/.Trash with fs.rename (atomic on the same volume),
// falling back to copy+rename-style move via fs.cpSync + fs.rename is NOT used — fs.rename
// only; this is a MOVE, never a delete. Returns the resting path on success, '' on failure.
// NOTE: fs.rename is a move, not a delete — the bytes survive in ~/.Trash, recoverable by the
// user. There is intentionally NO unlink/rm anywhere in this function.
function moveIntoTrash(item: string): string {
	const dest = trashTargetFor(path.basename(item));
	try {
		fs.renameSync(item, dest);
		return dest;
	} catch {
		return '';
	}
}

// Tries Finder's 'delete' (which moves to Trash, not a hard delete) via osascript, wrapped in a
// child-process timeout. Resolves true only if osascript exits 0 within the timeout. Any error,
// non-zero exit, or timeout resolves false so the caller falls back to the fs.rename move.
function finderTrash(items: string[]): Promise<boolean> {
	return new Promise(resolve => {
		if (items.length === 0) { resolve(true); return; }
		// Build an AppleScript POSIX-file list. Each path is embedded as a quoted AppleScript
		// string literal (quotes/backslashes escaped) and passed as a single -e argument — never
		// shell-concatenated — so a path can't break out into another command.
		const fileList = items.map(p => `POSIX file ${asStringLiteral(p)}`).join(', ');
		const script = `tell application "Finder" to delete { ${fileList} }`;
		const proc = spawn('osascript', ['-e', script]);
		let done = false;
		const finish = (ok: boolean): void => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			try { proc.kill('SIGKILL'); } catch { /* already gone */ }
			resolve(ok);
		};
		const timer = setTimeout(() => finish(false), OSASCRIPT_TIMEOUT_MS);
		proc.stderr.on('data', () => { /* ignore */ });
		proc.on('error', () => finish(false));
		proc.on('close', code => finish(code === 0));
	});
}

// Escapes a string for safe embedding inside an AppleScript double-quoted literal.
function asStringLiteral(s: string): string {
	return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// The public delete function. Accepts a single path and TRASHES it — Finder 'delete' first,
// then the ~/.Trash fs.rename fallback. Validates the path is absolute, existing, and under an
// allowed root before touching it. Returns the resting trash path on success, '' on failure.
// This is exported so main.ts's trashHelper and the self-test can exercise the exact move path.
export async function trashPath(target: string): Promise<string> {
	if (!isUnderAllowedRoot(target) || !existsSafe(target)) { return ''; }
	// Never move the .Trash folder itself — only items underneath get trashed.
	if (path.resolve(target) === path.resolve(TRASH_DIR)) { return ''; }
	const viaFinder = await finderTrash([target]);
	if (viaFinder && !existsSafe(target)) {
		// Finder reports success and the source is gone — it's in the Trash now. We don't know
		// Finder's exact resting name, so report the source path as proof the move happened.
		return target;
	}
	// Finder timed out or didn't move it — fall back to the guaranteed fs.rename move.
	return moveIntoTrash(target);
}

// Empties ~/.Trash for real. The 'trash' category's whole job is RECLAIMING space, but routing it
// through trashPath() can only RELOCATE items within ~/.Trash (it's an allowed root) — bytes never
// leave, so we'd credit space that's still occupied. Instead we ask Finder to empty the Trash, the
// one safe mechanism that actually removes the bytes while still going through the OS (no rm/unlink
// here). Timeout-guarded with the same SIGKILL pattern as finderTrash so a hung Finder can't stall
// a clean. Resolves true only on a clean exit 0 within the timeout.
function emptyTrashViaFinder(): Promise<boolean> {
	return new Promise(resolve => {
		const proc = spawn('osascript', ['-e', 'tell application "Finder" to empty the trash']);
		let done = false;
		const finish = (ok: boolean): void => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			try { proc.kill('SIGKILL'); } catch { /* already gone */ }
			resolve(ok);
		};
		const timer = setTimeout(() => finish(false), OSASCRIPT_TIMEOUT_MS);
		proc.stderr.on('data', () => { /* ignore */ });
		proc.on('error', () => finish(false));
		proc.on('close', code => finish(code === 0));
	});
}

// Lists the immediate child entries of a directory (the CONTENTS we trash when cleaning a
// category). Resolves [] on any error so a permission-blocked root degrades to "nothing moved"
// instead of throwing. Never follows into the entries — we move whole top-level items.
function contentsOf(dir: string): string[] {
	try {
		return fs.readdirSync(dir).map(name => path.join(dir, name));
	} catch {
		return [];
	}
}

// Optional override for the Trash-emptying step. Production leaves it undefined (real Finder via
// emptyTrashViaFinder). The self-test injects a sandbox-only emptier so we can prove the 'trash'
// category truly frees bytes WITHOUT invoking the real Finder (which ignores HOME and would empty
// the user's real Trash). The override must return true only after the bytes actually left ~/.Trash.
export interface CleanOptions {
	readonly emptyTrash?: () => Promise<boolean>;
}

// Phase-2, confirm-guarded in main.ts. For each selected category, moves the category's
// CONTENTS (top-level items) to the Trash via trashPath(). NEVER rm/unlink. Credits freed bytes by
// re-measuring each affected root before/after, so it only reports space that truly left. The
// 'trash' category instead EMPTIES the Trash (see below). In tests this is exercised ONLY against a
// throwaway os.tmpdir() fixture, with the Trash emptier injected — see junk.selftest.js.
export async function cleanJunk(keys: string[], opts: CleanOptions = {}): Promise<CleanResult> {
	const wanted = new Set(keys);
	const specs = CATEGORY_SPECS.filter(s => wanted.has(s.key));
	if (specs.length === 0) { return { ok: true, freedBytes: 0, movedPaths: [] }; }

	const emptyTrash = opts.emptyTrash ?? emptyTrashViaFinder;
	const movedPaths: string[] = [];
	let freedBytes = 0;

	for (const spec of specs) {
		// The 'trash' category is special: its whole job is reclaiming space, and you cannot do
		// that by "moving items to the Trash" (they're already there — trashPath would only rename
		// them WITHIN ~/.Trash and free nothing). Empty the Trash for real, then credit only the
		// bytes that actually LEFT the directory (re-measure before/after), never a blind estimate.
		if (spec.key === 'trash') {
			const dir = spec.root;
			if (!isUnderAllowedRoot(dir)) { continue; }
			const before = await duBytes([dir]);
			const emptied = await emptyTrash();
			const after = await duBytes([dir]);
			const shrank = Math.max(0, before - after);
			if (emptied && shrank > 0) {
				freedBytes += shrank;
				movedPaths.push(dir); // record the Trash dir as the thing we emptied
			}
			continue;
		}

		// Which directories' contents this category trashes.
		const targets = spec.key === 'browserData'
			? spec.sizeRoots.filter(d => existsSafe(d))
			: [spec.root];
		for (const dir of targets) {
			if (!isUnderAllowedRoot(dir)) { continue; }   // belt-and-suspenders
			const before = await duBytes([dir]);
			let movedFromThisDir = 0;
			for (const item of contentsOf(dir)) {
				const rest = await trashPath(item);
				if (rest) {
					movedPaths.push(rest);
					movedFromThisDir++;
				}
			}
			// Credit only the bytes that actually left this directory. Re-measure after the moves
			// instead of blindly crediting `before`, so a partial/blocked move can never over-report
			// reclaimed space (and a move that relocated within an allowed root frees nothing here).
			if (movedFromThisDir > 0) {
				const after = await duBytes([dir]);
				freedBytes += Math.max(0, before - after);
			}
		}
	}

	return { ok: true, freedBytes, movedPaths };
}
