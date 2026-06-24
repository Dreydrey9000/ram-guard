// Storage-engine self-test — runs the pure parsers/logic from dist/storage.js against fixture
// strings, no Electron and no real `du`/`df` spawning. Mirrors selftest.js (parseVmStat/parseProcs).
// Run with:  npm run build && node selftest-storage.js   (the npm "test" script also chains it).
const assert = require('assert');
const { parseDfK, parseStorageProfiler, parseDuK, estimateStorageBuckets } = require('./dist/storage.js');

// --- parseDfK: a real `df -k /System/Volumes/Data` shape → bytes from the right row ------------
// Two filesystems printed; we must pick the DATA mount, not the read-only /System row.
const DF = `Filesystem    1024-blocks       Used  Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s1   971350180  21000000  120000000    15%  400000 1200000000    0%   /System/Volumes/Data
/dev/disk3s5   971350180  10000000  120000000     8%  350000 1200000000    0%   /System/Volumes/Other`;
const df = parseDfK(DF, '/System/Volumes/Data');
assert(df.mount === '/System/Volumes/Data', 'parseDfK selects the Data volume row, not the first row');
assert(df.totalBytes === 971350180 * 1024, 'total = 1024-blocks * 1024');
assert(df.usedBytes === 21000000 * 1024, 'used = Used column of the Data row (21M blocks)');
assert(df.freeBytes === 120000000 * 1024, 'free = Available column of the Data row');

// Single-fs output (df with a path arg prints exactly one fs) → last row is that fs.
const DF1 = `Filesystem    1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1   971350180  21000000 120000000      15%  /System/Volumes/Data`;
const df1 = parseDfK(DF1, '/System/Volumes/Data');
assert(df1.usedBytes === 21000000 * 1024, 'single-fs df still parses the Used column');

// --- parseStorageProfiler: prefer the exact byte count in parentheses ------------------------
const SP = `Storage:

    Macintosh HD:

      Free: 412.91 GB (412,905,517,056 bytes)
      Capacity: 994.66 GB (994,662,584,320 bytes)
      Mount Point: /
      File System: APFS`;
const sp = parseStorageProfiler(SP);
assert(sp.freeBytes === 412905517056, 'profiler Free uses the exact bytes in parentheses');
assert(sp.capacityBytes === 994662584320, 'profiler Capacity uses the exact bytes in parentheses');

// Fallback path: no parenthesised bytes → convert the GB number.
const SP2 = `      Free: 100 GB\n      Capacity: 500 GB`;
const sp2 = parseStorageProfiler(SP2);
assert(sp2.freeBytes === 100 * 1024 ** 3, 'profiler Free falls back to GB conversion');
assert(sp2.capacityBytes === 500 * 1024 ** 3, 'profiler Capacity falls back to GB conversion');
// Garbage → nulls (caller falls back to df, never crashes).
const spNull = parseStorageProfiler('nothing here');
assert(spNull.freeBytes === null && spNull.capacityBytes === null, 'unparseable profiler → nulls');

// --- parseDuK: `du -sk` 1K-blocks → bytes, sums multi-root output ------------------------------
assert(parseDuK('524288\t/Applications') === 524288 * 1024, 'du -sk single root → bytes');
const DU_MULTI = `12000\t/Users/x/Documents\n8000\t/Users/x/Desktop\n4000\t/Users/x/Movies`;
assert(parseDuK(DU_MULTI) === (12000 + 8000 + 4000) * 1024, 'du -sk multi-root sums all rows');
assert(parseDuK('') === 0, 'empty du output → 0 (SIP-blocked root degrades, never NaN)');
assert(parseDuK('du: /private/var: Permission denied') === 0, 'du stderr-style line → 0, not NaN');

// --- estimateStorageBuckets: the stack ALWAYS sums to total (System clamped) -------------------
const total = 1000 * 1024 ** 3; // 1000 GB
const free = 400 * 1024 ** 3;   // 400 GB
const used = 600 * 1024 ** 3;   // 600 GB
const apps = 100 * 1024 ** 3;
const docs = 150 * 1024 ** 3;
const junk = 50 * 1024 ** 3;
const b = estimateStorageBuckets({
	totalBytes: total, usedBytes: used, freeBytes: free,
	applicationsBytes: apps, documentsBytes: docs, junkBytes: junk,
});
const byKey = Object.fromEntries(b.categories.map(c => [c.key, c.bytes]));
assert(byKey.system === used - apps - docs - junk, 'System is clamped to used - apps - docs - junk');
const sum = b.categories.reduce((s, c) => s + c.bytes, 0);
assert(sum === total, 'all five buckets sum to EXACTLY total (bar fills 100%)');
assert(Math.round(b.usedPct) === 60, 'usedPct = 600/1000 = 60%');
assert(b.categories.map(c => c.key).join(',') === 'system,applications,documents,junk,free', 'categories are in stack order: system, applications, documents, junk, free');
assert(b.categories.every(c => typeof c.color === 'string' && c.color.length > 0), 'every category carries a color');
assert(b.categories.every(c => typeof c.label === 'string' && c.label.length > 0), 'every category carries a label');

// Over-count guard: named buckets exceed `used` → System floors at 0, never negative.
const over = estimateStorageBuckets({
	totalBytes: total, usedBytes: 100 * 1024 ** 3, freeBytes: free,
	applicationsBytes: 80 * 1024 ** 3, documentsBytes: 80 * 1024 ** 3, junkBytes: 80 * 1024 ** 3,
});
const overSystem = over.categories.find(c => c.key === 'system');
assert(overSystem.bytes === 0, 'System floors at 0 when named buckets over-count used (no negative slice)');

// Real-APFS case: df's used + available DO NOT sum to total (purgeable/snapshot space). Free is
// the balancing slice, so the bar must STILL sum to exactly total (fills 100%).
const apfs = estimateStorageBuckets({
	totalBytes: 971350180 * 1024,   // 926 GB total
	usedBytes: 914410928 * 1024,    // 872 GB used (real df numbers from this machine)
	freeBytes: 3958564 * 1024,      // 3.8 GB available — note used+avail << total
	applicationsBytes: 45432032 * 1024,
	documentsBytes: 0, junkBytes: 0,
});
const apfsSum = apfs.categories.reduce((s, c) => s + c.bytes, 0);
assert(apfsSum === 971350180 * 1024, 'on real APFS (used+avail < total) the bar STILL sums to exactly total');
assert(apfs.categories.find(c => c.key === 'free').bytes === (971350180 - 914410928) * 1024, 'Free is the balancing slice: total - used, not df available');

// Zero df used → derive used from total - free so the bar still renders.
const derived = estimateStorageBuckets({
	totalBytes: total, usedBytes: 0, freeBytes: free,
	applicationsBytes: 0, documentsBytes: 0, junkBytes: 0,
});
assert(derived.usedBytes === total - free, 'used derives from total-free when df reports 0 used');

console.log('OK — storage parsers + bucket math verified.', JSON.stringify({
	dfUsedGb: Math.round(df.usedBytes / 1024 ** 3),
	usedPct: Math.round(b.usedPct),
}));
