// Runnable checks for the junk engine — the destructive part that would be catastrophic if it
// silently HARD-DELETED instead of moving to Trash. Run with: node junk.selftest.js
// (compiles first via npm test, or run after `npm run build`). No Electron, no display.
//
// SAFETY: every test below operates ONLY inside a throwaway directory under os.tmpdir(). We
// point HOME at that sandbox BEFORE requiring the module, so the engine's allowlist roots
// (~/Library/Caches, ~/Library/Logs, ~/.Trash) all resolve INSIDE the sandbox. No real user
// path is ever referenced, and the temp dir is removed at the end.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- build the throwaway sandbox and hijack HOME so the engine's roots live inside it --------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ramguard-junk-test-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SANDBOX;

// Recreate the engine's expected layout inside the sandbox.
const cachesDir = path.join(SANDBOX, 'Library', 'Caches');
const logsDir = path.join(SANDBOX, 'Library', 'Logs');
const trashDir = path.join(SANDBOX, '.Trash');
fs.mkdirSync(cachesDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(trashDir, { recursive: true });

// IMPORTANT: require AFTER HOME is set so os.homedir() inside the module reads the sandbox.
const junk = require('./dist/junk.js');

function cleanup() {
	process.env.HOME = REAL_HOME;
	try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
}

(async () => {
	try {
		// === 1. parseDuK: pure parser turns `du -sk` output into bytes, ignoring stderr noise. ===
		assert.strictEqual(junk.parseDuK('1024\t/some/dir'), 1024 * 1024, '1024 KB -> bytes');
		assert.strictEqual(
			junk.parseDuK('10\t/a\n20\t/b\ndu: /c: Permission denied'),
			30 * 1024,
			'sums KB columns, ignores the permission-denied line',
		);
		assert.strictEqual(junk.parseDuK(''), 0, 'empty output -> 0 bytes');

		// === 2. isUnderAllowedRoot: only sandbox cache/log/trash paths pass; arbitrary paths fail. ===
		assert.ok(junk.isUnderAllowedRoot(path.join(cachesDir, 'foo')), 'path under Caches allowed');
		assert.ok(junk.isUnderAllowedRoot(path.join(logsDir, 'bar.log')), 'path under Logs allowed');
		assert.ok(!junk.isUnderAllowedRoot('/etc/passwd'), 'arbitrary system path rejected');
		assert.ok(!junk.isUnderAllowedRoot('relative/path'), 'non-absolute path rejected');
		assert.ok(!junk.isUnderAllowedRoot(path.join(SANDBOX, 'Documents', 'x')), 'non-allowlisted dir rejected');

		// === 3. trashPath MOVES a file (never deletes it). The proof: gone from source, ===
		// ===    PRESENT in the trash target afterward. ===
		const victim = path.join(cachesDir, 'doomed.tmp');
		const MARKER = 'keep-me-recoverable';
		fs.writeFileSync(victim, MARKER);
		assert.ok(fs.existsSync(victim), 'precondition: victim exists in source');

		const rest = await junk.trashPath(victim);
		assert.ok(rest, 'trashPath returned a non-empty resting path');
		assert.ok(!fs.existsSync(victim), 'MOVE: source file is GONE from the cache dir');

		// The file content must still exist SOMEWHERE in the trash dir — proving move, not delete.
		const trashEntries = fs.readdirSync(trashDir);
		assert.ok(trashEntries.length >= 1, 'an item now lives in ~/.Trash');
		const recovered = trashEntries
			.map((n) => { try { return fs.readFileSync(path.join(trashDir, n), 'utf8'); } catch (_e) { return ''; } })
			.find((c) => c === MARKER);
		assert.strictEqual(recovered, MARKER, 'DELETE-PROOF: file CONTENTS survive intact in ~/.Trash');

		// === 4. trashPath refuses an arbitrary path outside the allowlist (returns '' , no move). ===
		const outsider = path.join(SANDBOX, 'outside.txt');
		fs.writeFileSync(outsider, 'do-not-touch');
		const refused = await junk.trashPath(outsider);
		assert.strictEqual(refused, '', 'arbitrary path is refused (empty result)');
		assert.ok(fs.existsSync(outsider), 'GUARD: the outside file was NOT moved or deleted');

		// === 5. cleanJunk('userCaches') moves the cache CONTENTS to Trash and never hard-deletes. ===
		const c1 = path.join(cachesDir, 'cache-a');
		const c2 = path.join(cachesDir, 'cache-b.dat');
		fs.writeFileSync(c1, 'aaa');
		fs.writeFileSync(c2, 'bbb');
		const result = await junk.cleanJunk(['userCaches']);
		assert.ok(result.ok, 'cleanJunk reports ok');
		assert.ok(Array.isArray(result.movedPaths), 'movedPaths is an array');
		assert.ok(result.movedPaths.length >= 2, 'both cache items were moved');
		assert.ok(!fs.existsSync(c1) && !fs.existsSync(c2), 'MOVE: cache items gone from source');
		// The cache ROOT itself must still exist — we trash CONTENTS, never the root folder.
		assert.ok(fs.existsSync(cachesDir), 'the Caches root folder itself is preserved');
		// Contents survive in Trash.
		const afterTrash = fs.readdirSync(trashDir);
		const survivors = afterTrash.map((n) => { try { return fs.readFileSync(path.join(trashDir, n), 'utf8'); } catch (_e) { return ''; } });
		assert.ok(survivors.includes('aaa') && survivors.includes('bbb'), 'DELETE-PROOF: both cache files recoverable from Trash');

		// === 6. cleanJunk with an unknown key is a safe no-op. ===
		const noop = await junk.cleanJunk(['notARealCategory']);
		assert.deepStrictEqual(noop, { ok: true, freedBytes: 0, movedPaths: [] }, 'unknown key -> harmless no-op');

		console.log('OK — junk engine verified (move-to-Trash, never hard-delete; allowlist enforced).');
		cleanup();
		process.exit(0);
	} catch (err) {
		cleanup();
		console.error('FAIL — junk selftest:', err && err.message ? err.message : err);
		process.exit(1);
	}
})();
