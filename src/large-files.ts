/*---------------------------------------------------------------------------------------------
 *  RAM Guard — the large-and-old-files engine.
 *
 *  Pure Node, zero Electron imports — so it can be unit-tested under plain `node`
 *  (see selftest-large-files.js). Finds big files (100MB+) in a BOUNDED set of user roots
 *  (Downloads/Movies/Documents/Desktop — NOT the whole disk), reads each file's last-access
 *  time (mdls kMDItemLastUsedDate, falling back to stat atime), keeps only files untouched
 *  for 90+ days, and sorts by size. Two actions: reveal in Finder (non-destructive) and
 *  move-to-Trash (NEVER hard-delete — osascript Finder 'delete' with a ~/.Trash fallback).
 *
 *  Mirrors src/ram.ts: spawn-based, Promises that resolve (never reject), and pure exported
 *  parse helpers (parseFindStat) so the self-test can verify parsing against fixture strings.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface LargeFile {
	readonly path: string;
	readonly name: string;
	readonly dir: string;
	readonly bytes: number;
	readonly mb: number;
	readonly lastUsedMs: number;   // epoch ms of last access (mdls, or atime fallback)
	readonly ageDays: number;      // days since last access
	readonly category: string;     // friendly bucket from the root the file lives under
}

export interface ScanLargeOpts {
	readonly minBytes?: number;    // size floor; default 100 MB (matches `find -size +100M`)
	readonly minAgeDays?: number;  // age floor; default 90 days
	readonly topN?: number;        // cap on returned rows; default 100
	readonly maxHits?: number;     // cap on raw find hits scanned; default 200
}

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

// BOUNDED roots — we never `find` the whole disk. Each maps to a friendly category label.
// These are the EXACT directories a scan looks under; nothing user-supplied is ever scanned.
interface Root { readonly path: string; readonly category: string; }

function scanRoots(): Root[] {
	const home = os.homedir();
	return [
		{ path: path.join(home, 'Downloads'), category: 'Downloads' },
		{ path: path.join(home, 'Movies'), category: 'Movies' },
		{ path: path.join(home, 'Documents'), category: 'Documents' },
		{ path: path.join(home, 'Desktop'), category: 'Desktop' },
	];
}

// A move-to-Trash is only allowed under these user roots (plus the scan roots above). A file
// the user picks must resolve to a real file under one of these before we ever move it.
function allowedTrashRoots(): string[] {
	const home = os.homedir();
	return [
		path.join(home, 'Downloads'),
		path.join(home, 'Movies'),
		path.join(home, 'Documents'),
		path.join(home, 'Desktop'),
		path.join(home, 'Music'),
		path.join(home, 'Pictures'),
	];
}

// True only when `child` sits inside `parent` (path-segment boundary, so /Users/a-b never
// counts as inside /Users/a). Both args are resolved to absolute real-ish paths first.
function isUnder(child: string, parent: string): boolean {
	const c = path.resolve(child);
	const p = path.resolve(parent);
	if (c === p) { return true; }
	return c.startsWith(p + path.sep);
}

/*---------------------------------------------------------------------------------------------
 *  SCAN (read-only)
 *--------------------------------------------------------------------------------------------*/

// `find <roots> -type f -size +100M` across the bounded roots, then for each hit read its
// last-access date and size. We DON'T trust find's clock; we re-stat each file. mdls gives the
// human "last opened" date, but it returns (null) for files Spotlight never indexed (verified:
// package.json had a null kMDItemLastUsedDate), so we fall back to `stat -f %a` atime.
// Everything is timeout-guarded and resolves partial/empty on error — one slow root can't hang
// or crash the view.
export function scanLargeFiles(opts: ScanLargeOpts = {}): Promise<LargeFile[]> {
	const minBytes = opts.minBytes ?? 100 * MB;
	const minAgeDays = opts.minAgeDays ?? 90;
	const topN = opts.topN ?? 100;
	const maxHits = opts.maxHits ?? 200;
	const findSizeM = Math.max(1, Math.floor(minBytes / MB)); // `find -size +<N>M`

	return new Promise(resolve => {
		if (process.platform !== 'darwin') { resolve([]); return; }
		const roots = scanRoots().filter(r => safeExistsDir(r.path));
		if (roots.length === 0) { resolve([]); return; }

		findHits(roots.map(r => r.path), findSizeM)
			.then(hits => {
				const capped = hits.slice(0, maxHits);
				return statHits(capped, roots);
			})
			.then(files => {
				const now = Date.now();
				const kept = files
					.filter(f => f.bytes >= minBytes && f.ageDays >= minAgeDays && now > 0)
					.sort((a, b) => b.bytes - a.bytes)
					.slice(0, topN);
				resolve(kept);
			})
			.catch(() => resolve([]));
	});
}

// Run `find <roots> -type f -size +<N>M`. -print0 so paths with spaces/newlines survive intact.
// Timeout-guarded (8s); on error/timeout we resolve whatever we collected so far (partial OK).
function findHits(roots: string[], sizeM: number): Promise<string[]> {
	return new Promise(resolve => {
		const args = [...roots, '-type', 'f', '-size', `+${sizeM}M`, '-print0'];
		const proc = spawn('find', args);
		proc.stdout.setEncoding('utf8');
		let out = '';
		let done = false;
		const finish = (): void => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			try { proc.kill(); } catch { /* already gone */ }
			resolve(out.split('\0').filter(p => p.length > 0));
		};
		const timer = setTimeout(finish, 8000);
		proc.stdout.on('data', (d: string) => { out += d; });
		proc.stderr.on('data', () => { /* permission-denied lines, ignore */ });
		proc.on('error', () => finish());
		proc.on('close', () => finish());
	});
}

// For a batch of paths, ask `stat` for atime+size+name in one call, and `mdls` for the richer
// "last used" date. We prefer mdls' date when present, else fall back to stat atime.
function statHits(paths: string[], roots: Root[]): Promise<LargeFile[]> {
	if (paths.length === 0) { return Promise.resolve([]); }
	return Promise.all([runStat(paths), runMdls(paths)]).then(([statMap, mdlsMap]) => {
		const now = Date.now();
		const out: LargeFile[] = [];
		for (const p of paths) {
			const s = statMap.get(p);
			if (!s) { continue; }
			const mdlsMs = mdlsMap.get(p) ?? 0;
			const lastUsedMs = mdlsMs > 0 ? mdlsMs : s.atimeMs;
			const ageDays = lastUsedMs > 0 ? Math.floor((now - lastUsedMs) / DAY_MS) : Number.MAX_SAFE_INTEGER;
			out.push(buildLargeFile(p, s.bytes, lastUsedMs, ageDays, roots));
		}
		return out;
	});
}

interface StatRow { readonly atimeMs: number; readonly bytes: number; }

// `stat -f '%a|%z|%N'` → "atime_seconds|size_bytes|/full/path". %a is access time in epoch
// seconds; %z is size; %N is the name we passed. We key the result map by that returned path
// so we can line each row back up with its mdls date.
function runStat(paths: string[]): Promise<Map<string, StatRow>> {
	return new Promise(resolve => {
		const proc = spawn('stat', ['-f', '%a|%z|%N', ...paths]);
		proc.stdout.setEncoding('utf8');
		let out = '';
		let done = false;
		const finish = (): void => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			try { proc.kill(); } catch { /* gone */ }
			resolve(parseStat(out));
		};
		const timer = setTimeout(finish, 6000);
		proc.stdout.on('data', (d: string) => { out += d; });
		proc.stderr.on('data', () => { /* ignore */ });
		proc.on('error', () => { resolve(new Map()); });
		proc.on('close', () => finish());
	});
}

// `mdls -name kMDItemLastUsedDate -name kMDItemFSSize <files...>` emits a block per file in the
// SAME order we passed them. We don't get the path back from mdls, so we zip its blocks against
// our input order. Any block whose date is "(null)" maps to 0 (caller then uses stat atime).
function runMdls(paths: string[]): Promise<Map<string, number>> {
	return new Promise(resolve => {
		const proc = spawn('mdls', ['-name', 'kMDItemLastUsedDate', '-name', 'kMDItemFSSize', ...paths]);
		proc.stdout.setEncoding('utf8');
		let out = '';
		let done = false;
		const finish = (): void => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			try { proc.kill(); } catch { /* gone */ }
			resolve(parseMdls(out, paths));
		};
		const timer = setTimeout(finish, 6000);
		proc.stdout.on('data', (d: string) => { out += d; });
		proc.stderr.on('data', () => { /* ignore */ });
		proc.on('error', () => { resolve(new Map()); });
		proc.on('close', () => finish());
	});
}

/*---------------------------------------------------------------------------------------------
 *  PURE PARSERS (no spawn) — verified directly by the self-test against fixture strings.
 *--------------------------------------------------------------------------------------------*/

// Parse `stat -f '%a|%z|%N'` output (one line per file) into a path→{atimeMs,bytes} map.
export function parseStat(out: string): Map<string, StatRow> {
	const map = new Map<string, StatRow>();
	for (const line of out.split('\n')) {
		if (!line.trim()) { continue; }
		// Split on the FIRST two pipes only; a path could (in theory) contain a pipe.
		const first = line.indexOf('|');
		if (first < 0) { continue; }
		const second = line.indexOf('|', first + 1);
		if (second < 0) { continue; }
		const atimeSec = Number(line.slice(0, first));
		const bytes = Number(line.slice(first + 1, second));
		const p = line.slice(second + 1);
		if (!Number.isFinite(atimeSec) || !Number.isFinite(bytes) || !p) { continue; }
		map.set(p, { atimeMs: atimeSec * 1000, bytes });
	}
	return map;
}

// Parse `mdls` output into a path→lastUsedMs map. mdls prints, per file:
//   kMDItemLastUsedDate    = 2024-01-15 10:30:00 +0000   (or "(null)")
//   kMDItemFSSize          = 12345
// separated by a blank-ish boundary; the blocks come back in the SAME order as `paths`, so we
// zip them. A "(null)" or unparseable date → 0 (caller falls back to stat atime).
export function parseMdls(out: string, paths: string[]): Map<string, number> {
	const map = new Map<string, number>();
	// Pull every kMDItemLastUsedDate value in order; one per file mdls was given.
	const dateValues: string[] = [];
	for (const line of out.split('\n')) {
		const m = line.match(/kMDItemLastUsedDate\s*=\s*(.*)$/);
		if (m) { dateValues.push(m[1].trim()); }
	}
	for (let i = 0; i < paths.length; i++) {
		const raw = dateValues[i];
		map.set(paths[i], mdlsDateToMs(raw));
	}
	return map;
}

// "2024-01-15 10:30:00 +0000" → epoch ms. "(null)"/missing/garbage → 0.
function mdlsDateToMs(raw: string | undefined): number {
	if (!raw || raw === '(null)') { return 0; }
	// mdls date form: "YYYY-MM-DD HH:MM:SS +ZZZZ". Date.parse needs a 'T' and a normalized zone.
	const m = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*([+-]\d{4})?$/);
	if (!m) {
		const direct = Date.parse(raw);
		return Number.isFinite(direct) ? direct : 0;
	}
	const zone = m[3] ? m[3].slice(0, 3) + ':' + m[3].slice(3) : 'Z';
	const iso = `${m[1]}T${m[2]}${zone}`;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : 0;
}

// Pure assembler used by both the live path and the self-test: turn (path,bytes,lastUsed,age)
// into a fully-shaped LargeFile, deriving name/dir and the friendly category from the root.
export function buildLargeFile(
	filePath: string,
	bytes: number,
	lastUsedMs: number,
	ageDays: number,
	roots: Root[],
): LargeFile {
	const root = roots.find(r => isUnder(filePath, r.path));
	return {
		path: filePath,
		name: path.basename(filePath),
		dir: path.dirname(filePath),
		bytes,
		mb: bytes / MB,
		lastUsedMs,
		ageDays,
		category: root ? root.category : 'Other',
	};
}

// Self-test helper: turn fixture `find`+`stat`+`mdls` strings into LargeFile[] WITHOUT spawning
// anything, so parsing can be asserted in isolation (mirrors parseProcs/parseVmStat in ram.ts).
// `findOut` is NUL-separated paths (like `find -print0`); statOut/mdlsOut are the raw tool dumps.
export function parseFindStat(
	findOut: string,
	statOut: string,
	mdlsOut: string,
	nowMs: number,
	rootsIn?: Root[],
): LargeFile[] {
	const roots = rootsIn ?? scanRoots();
	const paths = findOut.split('\0').filter(p => p.length > 0);
	const statMap = parseStat(statOut);
	const mdlsMap = parseMdls(mdlsOut, paths);
	const out: LargeFile[] = [];
	for (const p of paths) {
		const s = statMap.get(p);
		if (!s) { continue; }
		const mdlsMs = mdlsMap.get(p) ?? 0;
		const lastUsedMs = mdlsMs > 0 ? mdlsMs : s.atimeMs;
		const ageDays = lastUsedMs > 0 ? Math.floor((nowMs - lastUsedMs) / DAY_MS) : Number.MAX_SAFE_INTEGER;
		out.push(buildLargeFile(p, s.bytes, lastUsedMs, ageDays, roots));
	}
	return out.sort((a, b) => b.bytes - a.bytes);
}

/*---------------------------------------------------------------------------------------------
 *  ACTIONS
 *--------------------------------------------------------------------------------------------*/

// Reveal in Finder — `open -R <path>`. NON-destructive (opens a Finder window only), so this
// needs no confirm dialog. Matches the mockup's 'Reveal' button.
export function revealLargeFile(filePath: string): Promise<{ ok: boolean }> {
	return new Promise(resolve => {
		if (process.platform !== 'darwin') { resolve({ ok: false }); return; }
		const proc = spawn('open', ['-R', filePath]);
		proc.on('error', () => resolve({ ok: false }));
		proc.on('close', (code: number) => resolve({ ok: code === 0 }));
	});
}

// Move a large file to the Trash. DESTRUCTIVE — confirm-gated by main.ts before this is called.
// NEVER unlink/rm. Validates the path is an absolute, real, regular file under an allowed root,
// then moves it to the Trash via the shared helper (Finder 'delete' osascript, with a ~/.Trash
// fs.rename fallback because Finder AppleEvents were observed timing out live).
export function trashLargeFile(filePath: string): Promise<{ ok: boolean; trashedPath?: string }> {
	return new Promise(resolve => {
		if (process.platform !== 'darwin') { resolve({ ok: false }); return; }
		if (!validTarget(filePath)) { resolve({ ok: false }); return; }
		moveToTrash(filePath)
			.then(trashedPath => resolve({ ok: true, trashedPath }))
			.catch(() => resolve({ ok: false }));
	});
}

// A path is a valid trash target only when it is absolute, exists, is a regular file, and sits
// under one of the allowed user roots. Anything else (relative, missing, a directory, outside
// the allowlist) is rejected before any move — defense against a bad path reaching the mover.
export function validTarget(filePath: string): boolean {
	if (typeof filePath !== 'string' || filePath.length === 0) { return false; }
	if (!path.isAbsolute(filePath)) { return false; }
	let st: fs.Stats;
	try { st = fs.lstatSync(filePath); } catch { return false; }
	if (!st.isFile()) { return false; }
	return allowedTrashRoots().some(root => isUnder(filePath, root));
}

function safeExistsDir(dir: string): boolean {
	try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/*---------------------------------------------------------------------------------------------
 *  SHARED MOVE-TO-TRASH (the only deletion path; NEVER rm/unlink/fs.rm)
 *
 *  Tries osascript Finder 'delete' first. Finder AppleEvents were observed timing out live, so
 *  we wrap that call in a timeout and FALL BACK to moving the file into ~/.Trash via fs.rename
 *  (with a name-collision suffix). The file always ends up in the Trash, recoverable — it is
 *  never erased. Exported so the self-test can drive it against a throwaway tmpdir fixture.
 *--------------------------------------------------------------------------------------------*/

export function moveToTrash(filePath: string): Promise<string> {
	return finderDelete(filePath).catch(() => trashFallback(filePath));
}

// osascript: tell Finder to `delete` the POSIX file. Timeout-guarded (5s); on timeout/error/
// nonzero we reject so moveToTrash() falls through to the ~/.Trash rename. The path is passed
// as a quoted POSIX-file literal inside the AppleScript, never shell-concatenated.
function finderDelete(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const script = `tell application "Finder" to delete (POSIX file ${JSON.stringify(filePath)} as alias)`;
		const proc = spawn('osascript', ['-e', script]);
		let done = false;
		const finish = (ok: boolean): void => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			try { proc.kill(); } catch { /* gone */ }
			if (ok) {
				// Finder moved it to ~/.Trash; report the conventional landing path.
				resolve(path.join(os.homedir(), '.Trash', path.basename(filePath)));
			} else {
				reject(new Error('finder-delete-failed'));
			}
		};
		const timer = setTimeout(() => finish(false), 5000);
		proc.stderr.on('data', () => { /* ignore */ });
		proc.on('error', () => finish(false));
		proc.on('close', (code: number) => finish(code === 0));
	});
}

// Fallback mover: rename the file into ~/.Trash. This is a MOVE (fs.rename), not a delete —
// the bytes are preserved and recoverable from the Trash. On a name collision we suffix with a
// timestamp so we never clobber an existing trashed file. fs.rename across volumes can EXDEV;
// in that case we copy-then-rename-original-into-trash is overkill for same-volume user files,
// so we surface the error and let the caller's catch resolve ok:false (Finder path usually wins
// anyway). NEVER unlinks the source.
function trashFallback(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		try {
			const trashDir = path.join(os.homedir(), '.Trash');
			fs.mkdirSync(trashDir, { recursive: true });
			let dest = path.join(trashDir, path.basename(filePath));
			if (fs.existsSync(dest)) {
				const ext = path.extname(filePath);
				const base = path.basename(filePath, ext);
				dest = path.join(trashDir, `${base} ${Date.now()}${ext}`);
			}
			fs.renameSync(filePath, dest);
			resolve(dest);
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}
