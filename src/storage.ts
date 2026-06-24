/*---------------------------------------------------------------------------------------------
 *  RAM Guard — the storage engine.
 *
 *  Pure Node, zero Electron imports — so it can be unit-tested under plain `node` (see
 *  selftest.js), mirroring src/ram.ts. On macOS it reads the authoritative disk used/free/total
 *  from `df -k /System/Volumes/Data` (the boot DATA volume, where your files actually live —
 *  not the read-only /System "Macintosh HD" volume), cross-checks against
 *  `system_profiler SPStorageDataType`, then derives a category breakdown (System / Applications
 *  / Documents / Junk / Free) by du-sampling a fixed allowlist of known roots.
 *
 *  Every spawned command is timeout-guarded (6s) and resolves to a partial/zero value on error,
 *  so one slow or SIP-blocked `du` degrades the bar instead of crashing the view. parseDfK,
 *  parseStorageProfiler, and estimateStorageBuckets are pure exported helpers (no spawn) so the
 *  self-test can verify them against fixture strings, exactly like parseVmStat/parseProcs.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

const BYTES_PER_GB = 1024 * 1024 * 1024;
const DU_TIMEOUT_MS = 6000;

// The category keys the stacked bar renders, in stack order.
export type StorageCategoryKey = 'system' | 'applications' | 'documents' | 'junk' | 'free';

export interface StorageCategory {
	readonly key: StorageCategoryKey;
	readonly label: string;
	readonly bytes: number;
	readonly gb: number;
	readonly color: string;
}

export interface StorageInfo {
	readonly totalGb: number;
	readonly usedGb: number;
	readonly freeGb: number;
	readonly usedPct: number;
	readonly categories: readonly StorageCategory[];
}

// Raw byte counts that feed the pure bucket assembler. Kept separate from spawning so the
// self-test can prove the math (clamping, summing-to-100%) without touching the disk.
export interface StorageBucketInput {
	readonly totalBytes: number;
	readonly usedBytes: number;
	readonly freeBytes: number;
	readonly applicationsBytes: number;
	readonly documentsBytes: number;
	readonly junkBytes: number;
}

// `df -k` output (1K blocks). We parse the row whose mount point is the requested target so the
// numbers are the authoritative kernel view of the volume.
export interface DfResult {
	readonly totalBytes: number;
	readonly usedBytes: number;
	readonly freeBytes: number;
	readonly mount: string;
}

const COLORS: Record<StorageCategoryKey, string> = {
	system: '#8a8170',       // bone-grey — the OS + everything we did not bucket
	applications: '#c9a227', // gold — installed apps
	documents: '#6b7f6b',    // muted green — your files
	junk: '#b5651d',         // amber — caches/logs/trash, the reclaimable slice
	free: '#e8e2d0',         // pale bone — empty space
};

const LABELS: Record<StorageCategoryKey, string> = {
	system: 'System',
	applications: 'Applications',
	documents: 'Documents',
	junk: 'Junk & Caches',
	free: 'Free',
};

// --- pure parsers (no spawn) — fixture-testable, mirroring parseVmStat/parseProcs -------------

// Parse `df -k <target>` into bytes. df prints a header line then one row per filesystem; we
// take the row whose final column (mount point) matches `wantMount`, falling back to the LAST
// data row (df with a path arg prints exactly one fs, so the last row is that fs). 1K blocks → bytes.
export function parseDfK(out: string, wantMount = '/System/Volumes/Data'): DfResult {
	const lines = out.split('\n').map(l => l.trim()).filter(l => l.length > 0);
	// Drop the header row ("Filesystem 1024-blocks Used Available ...").
	const rows = lines.filter(l => !/^Filesystem\b/i.test(l));
	let chosen: string | undefined;
	for (const row of rows) {
		// Mount point is everything after the capacity %; match on the trailing path token(s).
		if (row.endsWith(wantMount) || row.endsWith(' ' + wantMount)) { chosen = row; break; }
	}
	if (!chosen && rows.length > 0) { chosen = rows[rows.length - 1]; }
	if (!chosen) { return { totalBytes: 0, usedBytes: 0, freeBytes: 0, mount: wantMount }; }

	// Columns: Filesystem  1024-blocks  Used  Available  Capacity%  iused  ifree  %iused  Mounted on
	// The filesystem name and mount can contain spaces, but the four numeric columns we need are
	// the first run of integers after the (single) filesystem token. df never spaces the device
	// token on macOS, so token[1..3] are total/used/avail in 1K blocks.
	const tokens = chosen.split(/\s+/);
	const total1k = Number(tokens[1]);
	const used1k = Number(tokens[2]);
	const avail1k = Number(tokens[3]);
	const k = 1024;
	const totalBytes = Number.isFinite(total1k) ? total1k * k : 0;
	const usedBytes = Number.isFinite(used1k) ? used1k * k : 0;
	const freeBytes = Number.isFinite(avail1k) ? avail1k * k : 0;
	// Mount point: rebuild from token index 8 onward (handles spaces in the mount path).
	const mount = tokens.length > 8 ? tokens.slice(8).join(' ') : (tokens[tokens.length - 1] || wantMount);
	return { totalBytes, usedBytes, freeBytes, mount };
}

// Cross-check helper: pull the Data volume's Free + Capacity (in bytes) from
// `system_profiler SPStorageDataType`. The output is an indented key/value block per volume;
// values look like "Free: 412.91 GB (412,905,517,056 bytes)". We prefer the exact byte count in
// parentheses; if absent we convert the GB/TB number. Returns nulls when nothing parses so the
// caller can fall back to df without crashing.
export function parseStorageProfiler(out: string): { freeBytes: number | null; capacityBytes: number | null } {
	const grab = (labelRe: RegExp): number | null => {
		const m = out.match(labelRe);
		if (!m) { return null; }
		const value = m[1];
		const parenBytes = value.match(/\(([\d,]+)\s*bytes\)/i);
		if (parenBytes) {
			const n = Number(parenBytes[1].replace(/,/g, ''));
			return Number.isFinite(n) ? n : null;
		}
		const unit = value.match(/([\d.]+)\s*(TB|GB|MB)/i);
		if (unit) {
			const n = Number(unit[1]);
			if (!Number.isFinite(n)) { return null; }
			const mult = /TB/i.test(unit[2]) ? 1024 ** 4 : /GB/i.test(unit[2]) ? 1024 ** 3 : 1024 ** 2;
			return Math.round(n * mult);
		}
		return null;
	};
	const freeBytes = grab(/Free:\s*(.+)/i);
	const capacityBytes = grab(/Capacity:\s*(.+)/i);
	return { freeBytes, capacityBytes };
}

// Parse `du -sk <root>` into bytes. du -sk prints "<1K-blocks>\t<path>" (one line, or several if
// multiple roots were passed); we sum every numeric leading column. Resolves 0 on empty/garbage
// so a SIP-blocked root (du can return nothing or "0") contributes nothing rather than NaN.
export function parseDuK(out: string): number {
	let total = 0;
	for (const line of out.split('\n')) {
		const m = line.match(/^\s*(\d+)\s+/);
		if (m) { total += Number(m[1]) * 1024; }
	}
	return total;
}

// --- pure bucket assembler — the math the self-test pins ---------------------------------------

// Assemble the categories[] array from raw byte inputs. The System bucket is CLAMPED to
// (used - applications - documents - junk) so the four used-slices plus Free always sum to total
// (the stacked bar fills exactly 100%). If the named buckets over-count used space (du double-
// counting, or estimates above the real used figure), System floors at 0 rather than going
// negative — the bar never renders an impossible slice.
export function estimateStorageBuckets(input: StorageBucketInput): {
	usedBytes: number;
	freeBytes: number;
	totalBytes: number;
	usedPct: number;
	categories: StorageCategory[];
} {
	const total = Math.max(0, input.totalBytes);
	const reportedFree = Math.max(0, input.freeBytes);
	const apps = Math.max(0, input.applicationsBytes);
	const docs = Math.max(0, input.documentsBytes);
	const junk = Math.max(0, input.junkBytes);
	// Trust df's used as the authoritative used figure; fall back to total-free when used is 0.
	const used = input.usedBytes > 0 ? input.usedBytes : Math.max(0, total - reportedFree);
	// Free is the BALANCING slice. On real APFS, df's used + available do NOT sum to total
	// (~5% goes to purgeable/snapshot space df doesn't attribute to either side). To keep the
	// promise that the stacked bar always fills exactly 100%, when we know a real `total` we set
	// free = total - used so used + free == total. When total is unknown (0, degraded/non-darwin)
	// we keep df's reported available so the number is still meaningful.
	const free = total > 0 ? Math.max(0, total - used) : reportedFree;
	// Clamp System so the four used-slices sum to exactly `used`.
	const system = Math.max(0, used - apps - docs - junk);

	const mk = (key: StorageCategoryKey, bytes: number): StorageCategory => ({
		key,
		label: LABELS[key],
		bytes,
		gb: bytes / BYTES_PER_GB,
		color: COLORS[key],
	});

	const categories: StorageCategory[] = [
		mk('system', system),
		mk('applications', apps),
		mk('documents', docs),
		mk('junk', junk),
		mk('free', free),
	];

	return {
		usedBytes: used,
		freeBytes: free,
		totalBytes: total,
		usedPct: total > 0 ? (used / total) * 100 : 0,
		categories,
	};
}

// --- spawning (timeout-guarded, partial-on-error) ----------------------------------------------

// Run a command, capture stdout, and resolve '' on ANY failure path (spawn error, non-zero exit,
// or a timeout that we kill ourselves). macOS has no `timeout` binary, so we arm our own timer
// and SIGKILL the child if it overruns — a single slow du can't hang the whole scan.
function runCapture(cmd: string, args: string[], timeoutMs = DU_TIMEOUT_MS): Promise<string> {
	return new Promise(resolve => {
		let out = '';
		let done = false;
		const finish = (value: string): void => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			resolve(value);
		};
		const proc = spawn(cmd, args);
		const timer = setTimeout(() => {
			try { proc.kill('SIGKILL'); } catch { /* already gone */ }
			finish(out); // partial-on-timeout
		}, timeoutMs);
		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', (d: string) => { out += d; });
		proc.stderr.on('data', () => { /* ignore — du warns on permission-denied subdirs */ });
		proc.on('error', () => finish(''));
		proc.on('close', () => finish(out));
	});
}

// `du -sk <root...>` summed to bytes, 0 on any error/timeout. Roots are a FIXED allowlist passed
// by the caller — never a user-supplied path.
function duBytes(roots: string[]): Promise<number> {
	if (roots.length === 0) { return Promise.resolve(0); }
	return runCapture('du', ['-sk', ...roots]).then(parseDuK).catch(() => 0);
}

function dfData(target: string): Promise<DfResult> {
	return runCapture('df', ['-k', target], 4000)
		.then(out => parseDfK(out, target))
		.catch(() => ({ totalBytes: 0, usedBytes: 0, freeBytes: 0, mount: target }));
}

function storageProfiler(): Promise<{ freeBytes: number | null; capacityBytes: number | null }> {
	return runCapture('system_profiler', ['SPStorageDataType'], 6000)
		.then(parseStorageProfiler)
		.catch(() => ({ freeBytes: null, capacityBytes: null }));
}

// The fixed, allowlisted document roots — your files, never an arbitrary path.
function documentRoots(): string[] {
	const home = os.homedir();
	return ['Documents', 'Desktop', 'Movies', 'Music', 'Pictures'].map(d => path.join(home, d));
}

// --- live entry point --------------------------------------------------------------------------

export interface StorageBreakdownOptions {
	// Bytes already counted as reclaimable junk by junk.ts estimateJunk(). The junk engine is a
	// sibling module; we inject its total here (defaulting to 0) so storage.ts stays independently
	// testable and never rejects if junk scanning errors or isn't wired yet.
	readonly junkBytes?: number;
}

// Wrap the byte-shaped bucket result into the full StorageInfo the renderer consumes (adds the
// GB convenience fields alongside the categories[]).
function toStorageInfo(b: ReturnType<typeof estimateStorageBuckets>): StorageInfo {
	return {
		totalGb: b.totalBytes / BYTES_PER_GB,
		usedGb: b.usedBytes / BYTES_PER_GB,
		freeGb: b.freeBytes / BYTES_PER_GB,
		usedPct: b.usedPct,
		categories: b.categories,
	};
}

// The authoritative breakdown. Runs df (truth for total/used/free) + system_profiler (cross-check)
// + du on Applications and the document roots in parallel; any bucket that errors resolves to 0.
export async function getStorageBreakdown(opts: StorageBreakdownOptions = {}): Promise<StorageInfo> {
	if (process.platform !== 'darwin') {
		// Off macOS there is no df DATA volume layout to trust — degrade to a single Free/used view
		// from os so callers still get a valid shape rather than an exception.
		const free = os.freemem();
		return toStorageInfo(estimateStorageBuckets({
			totalBytes: 0, usedBytes: 0, freeBytes: free,
			applicationsBytes: 0, documentsBytes: 0, junkBytes: 0,
		}));
	}

	const home = os.homedir();
	const [df, profiler, appsBytes, docsBytes] = await Promise.all([
		dfData('/System/Volumes/Data'),
		storageProfiler(),
		duBytes(['/Applications', path.join(home, 'Applications')]),
		duBytes(documentRoots()),
	]);

	// df is authoritative. Cross-check free against system_profiler; if df gave us nothing
	// (unlikely) but the profiler did, borrow the profiler's numbers so the bar still renders.
	let totalBytes = df.totalBytes;
	let usedBytes = df.usedBytes;
	let freeBytes = df.freeBytes;
	if (totalBytes === 0 && profiler.capacityBytes) { totalBytes = profiler.capacityBytes; }
	if (freeBytes === 0 && profiler.freeBytes) { freeBytes = profiler.freeBytes; }
	if (usedBytes === 0 && totalBytes > 0) { usedBytes = Math.max(0, totalBytes - freeBytes); }

	return toStorageInfo(estimateStorageBuckets({
		totalBytes,
		usedBytes,
		freeBytes,
		applicationsBytes: appsBytes,
		documentsBytes: docsBytes,
		junkBytes: Math.max(0, opts.junkBytes ?? 0),
	}));
}
