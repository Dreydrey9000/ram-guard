// Self-test for the login-items engine — runs under plain `node` (no Electron, no display).
// Run directly:  node login-items.selftest.js
// It is also chained from selftest.js so `npm test` exercises it too.
//
// Covers:
//   1. parseLoginItems — fixture strings → correct LoginItem[] (names zipped with hidden flags).
//   2. setLoginItem name-guard — rejects unsafe / non-allowlisted names WITHOUT touching real
//      login items (rejection happens before any osascript runs).
//   3. trashLoginItemTarget — proves the destructive path MOVES a file to the Trash (never
//      hard-deletes). Exercised ONLY against a throwaway dir we create ourselves, then removed.
//      NEVER references a real user file.
//
// SAFETY: we build a throwaway sandbox under os.tmpdir() and point HOME at it BEFORE requiring
// the module, so the engine's allowedTrashRoots() (os.homedir()) and the ~/.Trash fallback all
// resolve INSIDE the sandbox — never the real user home or the real ~/.Trash. HOME is restored
// and the sandbox removed at the end (same pattern as junk.selftest.js).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- build a throwaway sandbox under os.tmpdir() and hijack HOME so the engine's Trash roots --
// --- all resolve INSIDE the sandbox (exactly like junk.selftest.js). The engine resolves both -
// --- allowedTrashRoots() and the ~/.Trash fallback via os.homedir(), which reads process.env.HOME,
// --- so we MUST set HOME before requiring the module. No real user path is ever referenced.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ramguard-loginitems-test-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SANDBOX;

// The engine's ~/.Trash fallback needs the dir to exist; create it inside the sandbox.
const trashDir = path.join(SANDBOX, '.Trash');
fs.mkdirSync(trashDir, { recursive: true });

// IMPORTANT: require AFTER HOME is set so os.homedir() inside the module reads the sandbox.
const {
	parseLoginItems,
	setLoginItem,
	trashLoginItemTarget,
} = require('./dist/login-items.js');

function restoreHome() {
	process.env.HOME = REAL_HOME;
	try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

// 1) parser: two osascript result lines (names, then hidden flags) zip into LoginItem[].
const SAMPLE = 'CapCut, Granola, Raycast\nfalse, false, true';
const items = parseLoginItems(SAMPLE);
assert.strictEqual(items.length, 3, 'three login items parsed');
assert.strictEqual(items[0].name, 'CapCut', 'first name is CapCut');
assert.strictEqual(items[2].name, 'Raycast', 'third name is Raycast');
assert.strictEqual(items[0].hidden, false, 'CapCut not hidden');
assert.strictEqual(items[2].hidden, true, 'Raycast hidden flag parsed true');
assert.ok(items.every((it) => it.enabled === true), 'listed login items are enabled-at-login');

// empty list (System Events returns a blank line) → zero items, no crash.
assert.strictEqual(parseLoginItems('\n').length, 0, 'empty login-item list parses to []');
// names line with no hidden line → defaults hidden=false.
const oneLine = parseLoginItems('Slack');
assert.strictEqual(oneLine.length, 1, 'single name with no hidden line still parses');
assert.strictEqual(oneLine[0].hidden, false, 'missing hidden flag defaults to false');

// 2) name-guard: an unsafe name (quote → AppleScript-string breakout attempt) is rejected
// up-front, returning {ok:false} and never reaching osascript. A non-allowlisted plain name is
// also rejected because it is not in the live listLoginItems() set. Both assertions are safe to
// run anywhere: the guard short-circuits before any system call that would mutate login items.
(async () => {
	const unsafe = await setLoginItem('Evil" name', false);
	assert.strictEqual(unsafe.ok, false, 'unsafe login-item name rejected before any osascript');

	const bogus = await setLoginItem('definitely-not-a-real-login-item-xyz', false);
	assert.strictEqual(bogus.ok, false, 'non-allowlisted login-item name rejected (not in live set)');

	// 3) trash round-trip — MOVE proof, against a throwaway dir we create under the sandbox HOME
	// (the engine's allowed Trash root is os.homedir(), which is now the tmpdir sandbox). We
	// never reference a real user file — HOME was hijacked to a tmpdir before the module loaded.
	const tmpDir = fs.mkdtempSync(path.join(os.homedir(), '.ram-guard-selftest-'));
	const tmpDir2 = fs.mkdtempSync(path.join(os.homedir(), '.ram-guard-selftest-bs-'));
	const tmpFile = path.join(tmpDir, 'throwaway-login-helper.txt');
	fs.writeFileSync(tmpFile, 'disposable fixture — safe to trash');
	assert.ok(fs.existsSync(tmpFile), 'fixture file exists before trashing');

	const res = await trashLoginItemTarget(tmpFile);
	assert.strictEqual(res.ok, true, 'trash move reports ok');
	assert.ok(res.trashedPath, 'trash move returns the destination path');

	// MOVE, not delete: source is GONE, destination is PRESENT (in the Trash).
	assert.ok(!fs.existsSync(tmpFile), 'source file is GONE from the source dir (it moved)');
	assert.ok(fs.existsSync(res.trashedPath), 'file is PRESENT at the trash destination (proves move, not delete)');

	// guard proof: a path OUTSIDE the allowed root is refused. The only allowed root is now the
	// sandbox HOME, so a dir under the real tmpdir root (a sibling of the sandbox, NOT inside it)
	// is outside the allowlist and must be rejected untouched.
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ram-guard-outside-'));
	const outsideFile = path.join(outsideDir, 'untouchable.txt');
	fs.writeFileSync(outsideFile, 'must NOT be trashed — outside allowed root');
	const refused = await trashLoginItemTarget(outsideFile);
	assert.strictEqual(refused.ok, false, 'path outside allowed root is refused');
	assert.ok(fs.existsSync(outsideFile), 'file outside allowed root is untouched');

	// 4) INJECTION REGRESSION — a path containing a BACKSLASH must NEVER be string-concatenated
	// into an osascript literal. The old code did `abs.replace(/"/g, '')` (stripping quotes,
	// ignoring backslashes), so a crafted name ending in a backslash escaped the closing quote and
	// could break out into `do shell script`. The fix hard-rejects backslash/newline paths BEFORE
	// building any script and routes them to the pure-Node fs.rename fallback. We prove it by
	// trashing a real file whose NAME contains a backslash: it must still MOVE (via the fallback),
	// original gone + copy present, and no osascript ever sees the path. (macOS filenames may
	// legally contain a backslash; the path separator is '/'.)
	const backslashName = 'pwn\\name.txt';        // one literal backslash inside the filename
	const backslashFile = path.join(tmpDir2, backslashName);
	fs.writeFileSync(backslashFile, 'crafted name — must move via fs.rename, never via osascript');
	assert.ok(fs.existsSync(backslashFile), 'backslash-named fixture created');

	const bsRes = await trashLoginItemTarget(backslashFile);
	assert.strictEqual(bsRes.ok, true, 'backslash path still moves safely (via the fs.rename fallback)');
	assert.ok(bsRes.trashedPath, 'backslash path move returns a destination');
	assert.ok(!fs.existsSync(backslashFile), 'INJECTION-SAFE: backslash source is GONE (moved, not run)');
	assert.ok(fs.existsSync(bsRes.trashedPath), 'INJECTION-SAFE: backslash file PRESENT in Trash (a move, not a delete)');

	// cleanup: remove our throwaway items so the test leaves no trace.
	// (fs.rmSync here is on OUR OWN throwaway fixtures only — never a user path — and is test
	// teardown, not the app's delete path; the app itself only ever moves to Trash.)
	try { fs.rmSync(res.trashedPath, { force: true }); } catch (e) { /* best effort */ }
	try { fs.rmSync(bsRes.trashedPath, { force: true }); } catch (e) { /* best effort */ }
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
	try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch (e) { /* best effort */ }
	try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }

	console.log('OK — login-items parsers + name-guard + trash-move + injection-guard verified.');
	restoreHome();
})().catch((e) => {
	restoreHome();
	console.error('login-items selftest FAILED:', e && e.message ? e.message : e);
	process.exit(1);
});
