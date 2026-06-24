/*---------------------------------------------------------------------------------------------
 *  RAM Guard — the login-items engine.
 *
 *  Pure Node, zero Electron imports — so it can be unit-tested under plain `node` (see
 *  login-items.selftest.js), exactly like ram.ts. On macOS it lists the apps set to open at
 *  login via `osascript` against System Events, and (Phase-2, confirm-gated in main.ts) toggles
 *  a login item on/off. The destructive helper here NEVER hard-deletes: it moves a path to the
 *  Trash (Finder 'delete' via osascript, with a ~/.Trash fs.rename fallback because Finder
 *  AppleEvents were observed timing out live).
 *
 *  Two kinds of "remove" live here, kept deliberately separate:
 *    - setLoginItem(name,false): a SYSTEM-STATE change (stop opening at login). This is NOT a
 *      file delete, so the Trash rule is N/A; the guardrail is confirm-first (in main.ts) plus
 *      a name-allowlist (validated against listLoginItems()), and the name is passed as a
 *      discrete osascript `-e` argument literal — never shell-concatenated.
 *    - trashLoginItemTarget(path): a FILE move-to-Trash for the rare case where a login item's
 *      backing helper file should also be removed. Accepts a path and trashes it; never unlinks.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface LoginItem {
	readonly name: string;     // friendly login-item name, e.g. "Raycast"
	readonly hidden: boolean;  // System Events "hidden" flag (starts minimized / in background)
	readonly enabled: boolean; // System Events login items are enabled-at-login by definition;
	                           // this flips to false once the item is removed.
}

export interface SetLoginResult {
	readonly ok: boolean;
}

export interface TrashResult {
	readonly ok: boolean;
	readonly trashedPath?: string;
}

// A login-item name that survives the round-trip into an osascript string literal unharmed.
// We list the live items and validate against THAT set before any state change, so this is a
// belt-and-braces second gate: even an allowlisted name must look like a plain item label.
// (Rejects quotes/backslashes/newlines that could break out of the AppleScript string.)
function isSafeName(name: string): boolean {
	return typeof name === 'string'
		&& name.length > 0
		&& name.length <= 256
		&& !/["\\\n\r]/.test(name);
}

// Run an osascript program made of discrete statements. Each statement is passed as its own
// `-e` argument (the macOS-blessed way), so nothing is ever concatenated into a shell string —
// item names travel as AppleScript string literals inside these args, never as shell tokens.
// Timeout-guarded; on any error/timeout the caller decides the safe fallback value.
function runOsascript(lines: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const args: string[] = [];
		for (const line of lines) { args.push('-e', line); }
		const proc = spawn('osascript', args);
		proc.stdout.setEncoding('utf8');
		let out = '';
		let settled = false;
		const done = (fn: () => void) => { if (settled) { return; } settled = true; clearTimeout(timer); fn(); };
		const timer = setTimeout(() => {
			try { proc.kill('SIGKILL'); } catch { /* already gone */ }
			done(() => reject(new Error('osascript timeout')));
		}, timeoutMs);
		proc.stdout.on('data', (d: string) => { out += d; });
		proc.stderr.on('data', () => { /* ignore — errors surface via non-zero close/parse */ });
		proc.on('error', (e: Error) => done(() => reject(e)));
		proc.on('close', (code: number) => {
			if (code === 0) { done(() => resolve(out)); }
			else { done(() => reject(new Error('osascript exit ' + code))); }
		});
	});
}

// Lists the apps macOS opens at login. We ask System Events for two parallel lists — the names
// and the hidden flags — then zip them in parseLoginItems(). On ANY error (System Events not
// scriptable, timeout, parse failure) we resolve [] so the Login view degrades to empty rather
// than crashing the whole window — same defensive posture as getSystemRam()/listTopProcesses().
export function listLoginItems(): Promise<LoginItem[]> {
	return new Promise(resolve => {
		if (process.platform !== 'darwin') { resolve([]); return; }
		runOsascript(
			[
				'tell application "System Events" to get the name of every login item',
				'tell application "System Events" to get the hidden of every login item',
			],
			6000,
		)
			.then(out => {
				try { resolve(parseLoginItems(out)); } catch { resolve([]); }
			})
			.catch(() => resolve([]));
	});
}

// Pure parser (no spawn) so the self-test can verify it against fixture strings, mirroring
// parseVmStat/parseProcs. osascript prints each `-e` result on its own line as a comma-space
// list, e.g.:
//   CapCut, Granola, Raycast
//   false, false, true
// First line = names, second line = matching hidden booleans. A missing/short hidden line just
// defaults hidden=false. enabled is always true here (a listed login item opens at login).
export function parseLoginItems(out: string): LoginItem[] {
	const lines = out.split('\n').map(l => l.trim()).filter(l => l.length > 0);
	if (lines.length === 0) { return []; }
	const names = splitAppleList(lines[0]);
	const hiddenRaw = lines.length > 1 ? splitAppleList(lines[1]) : [];
	const items: LoginItem[] = [];
	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		if (!name) { continue; }
		const hidden = (hiddenRaw[i] || '').toLowerCase() === 'true';
		items.push({ name, hidden, enabled: true });
	}
	return items;
}

// AppleScript prints a list as "a, b, c". An empty list prints as "" → zero items. We trim each
// element; item names with commas are extraordinarily rare for login items and out of scope.
function splitAppleList(line: string): string[] {
	if (line.length === 0) { return []; }
	return line.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

// Phase-2, confirm-gated in main.ts (toggling startup is a system-state change — main.ts opens
// the confirm dialog before calling this). enabled=false deletes the login item; enabled=true
// is intentionally NOT supported from a bare name alone, because re-adding requires the app's
// on-disk path (System Events `make login item ... with properties {path:...}`) which this
// engine does not have — main.ts/the renderer must supply it via a future path-aware re-add.
// The guardrail here: the name MUST already be in the live listLoginItems() set (no arbitrary
// names) AND pass isSafeName(), and it travels as an osascript `-e` literal, never shell-joined.
export function setLoginItem(name: string, enabled: boolean): Promise<SetLoginResult> {
	return new Promise(resolve => {
		if (process.platform !== 'darwin') { resolve({ ok: false }); return; }
		if (!isSafeName(name)) { resolve({ ok: false }); return; }
		listLoginItems()
			.then(items => {
				const known = items.some(it => it.name === name);
				if (!known) { resolve({ ok: false }); return; }
				if (enabled) {
					// Re-adding needs the app path we don't hold here — surface as not-ok rather
					// than guess a path. Kept explicit so callers know to route a path-aware add.
					resolve({ ok: false });
					return;
				}
				// The name is embedded as an AppleScript string literal inside a single `-e`
				// arg. isSafeName() already rejected quotes/backslashes, so the literal is well
				// formed; nothing reaches a shell.
				runOsascript(
					['tell application "System Events" to delete login item "' + name + '"'],
					6000,
				)
					.then(() => resolve({ ok: true }))
					.catch(() => resolve({ ok: false }));
			})
			.catch(() => resolve({ ok: false }));
	});
}

// The roots a Trash move is allowed to touch. Login-item backing files live under the user's
// home (LaunchAgents, app helper apps); we never move anything outside the home directory, and
// never a system/SIP path. Resolved once at module load.
function allowedTrashRoots(): string[] {
	const home = os.homedir();
	return [home];
}

// SHARED move-to-Trash. Validates the path is absolute, real, and under an allowed root, then
// moves it to the Trash. Tries the Finder 'delete' AppleEvent first (it lands the item in the
// Trash with full undo metadata); because Finder AppleEvents were observed timing out live, it
// FALLS BACK to a plain fs.rename into ~/.Trash with a collision-avoiding suffix. NEVER calls
// fs.rm/unlink/rmdir — this only ever MOVES, so a mistake is always recoverable from the Trash.
export function trashLoginItemTarget(target: string): Promise<TrashResult> {
	return new Promise(resolve => {
		let abs: string;
		try { abs = path.resolve(target); } catch { resolve({ ok: false }); return; }
		if (!path.isAbsolute(abs)) { resolve({ ok: false }); return; }
		if (!isUnderAllowedRoot(abs)) { resolve({ ok: false }); return; }
		let exists = false;
		try { exists = fs.existsSync(abs); } catch { exists = false; }
		if (!exists) { resolve({ ok: false }); return; }

		// Hard-reject paths that can't be safely embedded in an AppleScript literal. A backslash
		// or newline in a filename is the exact vector that lets a crafted name break out of the
		// string and run arbitrary AppleScript, so refuse those before building any script and
		// route them straight to the pure-Node fs.rename fallback (no osascript involved).
		if (/[\\\n\r]/.test(abs)) { renameFallback(abs).then(resolve); return; }

		// Try Finder first (best UX: real Trash with undo), but only on darwin and only if it
		// answers within the timeout. The path is embedded as a properly-escaped AppleScript
		// string literal (escape backslash THEN quote) — NEVER by stripping characters from the
		// path we intend to act on. Any failure routes to the fs.rename fallback.
		const finderThenFallback = (): void => {
			if (process.platform !== 'darwin') { renameFallback(abs).then(resolve); return; }
			runOsascript(
				['tell application "Finder" to delete (POSIX file ' + asStringLiteral(abs) + ') as alias'],
				4000,
			)
				.then(() => resolve({ ok: true, trashedPath: trashPathFor(abs) }))
				.catch(() => { renameFallback(abs).then(resolve); });
		};
		finderThenFallback();
	});
}

function isUnderAllowedRoot(abs: string): boolean {
	for (const root of allowedTrashRoots()) {
		const r = root.endsWith(path.sep) ? root : root + path.sep;
		if (abs === root || abs.startsWith(r)) { return true; }
	}
	return false;
}

function trashPathFor(abs: string): string {
	return path.join(os.homedir(), '.Trash', path.basename(abs));
}

// Escapes a string for safe embedding inside an AppleScript double-quoted literal. Backslash MUST
// be escaped FIRST, then the quote, so a path can never terminate the literal early and break out
// into executable AppleScript. Mirrors the asStringLiteral() escaper in junk.ts. We additionally
// reject backslash/newline-bearing paths upstream (see trashLoginItemTarget) as a second gate.
function asStringLiteral(s: string): string {
	return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// The mandatory fallback: move the path into ~/.Trash with fs.rename. On a name collision in
// the Trash we append a timestamp so we never overwrite an existing trashed item. Still a MOVE,
// never a delete — the file remains on disk, just relocated to the Trash.
function renameFallback(abs: string): Promise<TrashResult> {
	return new Promise(resolve => {
		const trashDir = path.join(os.homedir(), '.Trash');
		try { fs.mkdirSync(trashDir, { recursive: true }); } catch { /* exists or not permitted */ }
		let dest = path.join(trashDir, path.basename(abs));
		try {
			if (fs.existsSync(dest)) {
				const ext = path.extname(dest);
				const base = path.basename(dest, ext);
				dest = path.join(trashDir, base + ' ' + Date.now() + ext);
			}
			fs.renameSync(abs, dest);
			resolve({ ok: true, trashedPath: dest });
		} catch {
			resolve({ ok: false });
		}
	});
}
