/*---------------------------------------------------------------------------------------------
 *  RAM Guard — the memory engine.
 *
 *  Ported verbatim from the Ursula RAM Guard VS Code extension's core (the part that has
 *  nothing to do with Claude). Pure Node, zero Electron imports — so it can be unit-tested
 *  under plain `node` (see selftest.js). On macOS it reads TRUE memory pressure via `vm_stat`
 *  (the compressor number predicts an out-of-memory freeze better than "free RAM" does), and
 *  lists the apps eating the most memory via `ps`.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import { spawn } from 'child_process';

export interface RamInfo {
	readonly usedPct: number;
	readonly freeMb: number;
	readonly totalGb: number;
	readonly usedGb: number;
	readonly compressorMb: number;
}

export interface Proc {
	readonly pid: number;     // the biggest single process in this app's group (the kill target)
	readonly rssMb: number;   // summed memory across the whole app group
	readonly name: string;    // friendly app name, e.g. "Google Chrome"
}

function ramInfoFallback(): RamInfo {
	const total = os.totalmem();
	const free = os.freemem();
	const used = total - free;
	return {
		usedPct: (used / total) * 100,
		freeMb: free / 1024 / 1024,
		totalGb: total / 1024 / 1024 / 1024,
		usedGb: used / 1024 / 1024 / 1024,
		compressorMb: 0,
	};
}

// On macOS, os.freemem() is optimistic — it over-counts reclaimable memory as "free", so a
// warning can fire too late (after the OS already killed something). vm_stat gives the true
// picture: pages the compressor is holding (the strongest single OOM signal on macOS) plus
// genuinely reclaimable pages. Falls back to os.freemem on non-darwin / on any error.
// This engine is the ONLY one on the live 5s poll loop (main.ts tick()), so a hung vm_stat would
// freeze the menu-bar pill forever. macOS has no `timeout` binary, so we arm our OWN timer and
// SIGKILL the child if it overruns — exactly the timer+SIGKILL+done-flag pattern storage.ts uses.
// On timeout we resolve the os.freemem() fallback so the pill keeps updating instead of stalling.
const VM_STAT_TIMEOUT_MS = 3000;

export function getSystemRam(): Promise<RamInfo> {
	return new Promise(resolve => {
		if (process.platform !== 'darwin') { resolve(ramInfoFallback()); return; }
		const proc = spawn('vm_stat');
		proc.stdout.setEncoding('utf8');
		let out = '';
		let done = false;
		const finish = (value: RamInfo): void => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			try { proc.kill('SIGKILL'); } catch { /* already gone */ }
			resolve(value);
		};
		const timer = setTimeout(() => finish(ramInfoFallback()), VM_STAT_TIMEOUT_MS);
		proc.stdout.on('data', (d: string) => { out += d; });
		proc.stderr.on('data', () => { /* ignore */ });
		proc.on('error', () => finish(ramInfoFallback()));
		proc.on('close', () => {
			try { finish(parseVmStat(out)); } catch { finish(ramInfoFallback()); }
		});
	});
}

export function parseVmStat(out: string): RamInfo {
	const total = os.totalmem();
	const psMatch = out.match(/page size of (\d+) bytes/);
	const pageSize = psMatch ? Number(psMatch[1]) : 16384;
	const pages = (label: string): number => {
		const m = out.match(new RegExp(label + ':\\s+(\\d+)'));
		return m ? Number(m[1]) * pageSize : 0;
	};
	// Reclaimable-without-swap-in: free + speculative + inactive + purgeable.
	const freeBytes = pages('Pages free') + pages('Pages speculative') + pages('Pages inactive') + pages('Pages purgeable');
	const compressorBytes = pages('Pages occupied by compressor');
	const used = total - freeBytes;
	return {
		usedPct: (used / total) * 100,
		freeMb: freeBytes / 1024 / 1024,
		totalGb: total / 1024 / 1024 / 1024,
		usedGb: used / 1024 / 1024 / 1024,
		compressorMb: compressorBytes / 1024 / 1024,
	};
}

// System processes a normal person should never be offered a "Quit" button for — quitting
// WindowServer logs you out, killing kernel_task is impossible anyway.
const SYSTEM = new Set([
	'kernel_task', 'WindowServer', 'launchd', 'logd', 'loginwindow', 'mds', 'mds_stores',
	'mdworker', 'mdworker_shared', 'coreaudiod', 'cfprefsd', 'distnoted', 'hidd', 'powerd',
]);

// Like getSystemRam, this runs on the live 5s poll loop, so `ps` MUST be timeout-guarded or a hung
// ps freezes the pill (and, without an overlap guard in tick(), piles up children every 5s). Same
// timer+SIGKILL+done-flag pattern; on timeout we resolve [] so the process list just goes empty.
const PS_TIMEOUT_MS = 3000;

export function listTopProcesses(topN = 8): Promise<Proc[]> {
	return new Promise(resolve => {
		const proc = spawn('ps', ['-axo', 'pid=,rss=,comm=']);
		proc.stdout.setEncoding('utf8');
		let out = '';
		let done = false;
		const finish = (value: Proc[]): void => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			try { proc.kill('SIGKILL'); } catch { /* already gone */ }
			resolve(value);
		};
		const timer = setTimeout(() => finish([]), PS_TIMEOUT_MS);
		proc.stdout.on('data', (d: string) => { out += d; });
		proc.stderr.on('data', () => { /* ignore */ });
		proc.on('error', () => finish([]));
		proc.on('close', () => finish(parseProcs(out, topN)));
	});
}

// Group every process by its parent .app so Chrome's 30 helper processes collapse into one
// "Google Chrome" row (summed RAM) instead of flooding the list. The kill target is the
// biggest single pid in the group — clicking Quit frees the most memory in one shot.
// ponytail: kills the heaviest pid, which frees the most RAM but may not gracefully quit the
// whole app. Upgrade path: `osascript -e 'quit app "<name>"'` for a clean app quit.
export function parseProcs(out: string, topN: number): Proc[] {
	const groups = new Map<string, { rssMb: number; pid: number; max: number }>();
	for (const line of out.split('\n')) {
		const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
		if (!m) { continue; }
		const pid = Number(m[1]);
		const rssMb = Number(m[2]) / 1024;
		const comm = m[3];
		if (!comm) { continue; }
		const name = appName(comm);
		if (SYSTEM.has(name)) { continue; }
		const g = groups.get(name);
		if (g) {
			g.rssMb += rssMb;
			if (rssMb > g.max) { g.max = rssMb; g.pid = pid; }
		} else {
			groups.set(name, { rssMb, pid, max: rssMb });
		}
	}
	return [...groups.entries()]
		.map(([name, g]) => ({ name, pid: g.pid, rssMb: g.rssMb }))
		.sort((a, b) => b.rssMb - a.rssMb)
		.slice(0, topN);
}

function appName(comm: string): string {
	// First ".app/" in the path is the top-level app (helpers live deeper), so this groups
	// "/Applications/Google Chrome.app/.../Helper" under "Google Chrome".
	const am = comm.match(/\/([^/]+)\.app\//);
	if (am) { return am[1]; }
	return comm.split('/').pop() || comm;
}
