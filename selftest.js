// One runnable check on the parsing logic — the part that would silently lie if it broke.
// Run with: npm test  (compiles, then runs this under plain node — no Electron, no display).
const assert = require('assert');
const { parseVmStat, parseProcs } = require('./dist/ram.js');

// vm_stat parser: a known sample → a sane RAM reading.
const SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                          100000.
Pages active:                        200000.
Pages inactive:                       50000.
Pages speculative:                    10000.
Pages purgeable:                       5000.
Pages occupied by compressor:         30000.`;
const r = parseVmStat(SAMPLE);
assert(r.usedPct >= 0 && r.usedPct <= 100, 'usedPct must be a percentage');
assert(r.compressorMb > 400 && r.compressorMb < 500, 'compressor: 30000 pages * 16KB ≈ 468 MB');

// process parser: Chrome's main + helper collapse into ONE "Google Chrome" group (summed),
// system processes are dropped, and rows are sorted by memory.
const PS = [
	'1 1000 /sbin/launchd',
	'200 500000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'201 300000 /Applications/Google Chrome.app/Contents/Frameworks/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper',
	'300 80000 /Applications/Slack.app/Contents/MacOS/Slack',
].join('\n');
const procs = parseProcs(PS, 5);
assert(!procs.find((p) => p.name === 'launchd'), 'system process launchd must be filtered out');
assert(procs[0].name === 'Google Chrome', 'biggest group sorts first');
assert(Math.round(procs[0].rssMb) === Math.round((500000 + 300000) / 1024), 'Chrome group RAM is summed');
assert(procs[0].pid === 200, 'kill target is the heaviest pid in the group');
assert(procs.length === 2, 'two real apps: Chrome + Slack');

console.log('OK — parsers verified.', JSON.stringify(r));

// Chain the login-items engine self-test so `npm test` covers it too. This file is
// self-contained (it exits non-zero on failure) and touches ONLY throwaway fixtures it
// creates itself — never a real login item or user file.
require('./login-items.selftest.js');
