// Self-test for the installed-apps engine (src/apps.ts → dist/apps.js).
// Runs under plain `node` — no Electron, no display. Two halves:
//   1. PURE PARSERS against fixture strings (parseDuKApps, parseBundleId, parseAppList) — the
//      part that would silently lie if it broke.
//   2. THE DESTRUCTIVE PATH proven SAFE: builds a throwaway fake "App.app" under os.tmpdir(),
//      runs the real move-to-Trash logic against it, and asserts the source is GONE and the item
//      is PRESENT in the Trash — i.e. it MOVED, it did not delete. Then it removes both the temp
//      dir and the Trash artifact. NEVER references a real user path or a real /Applications app.
//
// Run with: node apps.selftest.js   (build first: npm run build)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
	parseDuKApps,
	parseBundleId,
	parseAppList,
	moveToTrash,
	uninstallApp,
	findAppLeftovers,
} = require('./dist/apps.js');

(async () => {
	// ---- 1. PURE PARSERS -----------------------------------------------------------------
	// du -sk output: "<kilobytes>\t<path>" → bytes. SIP apps print 0.
	assert.strictEqual(parseDuKApps('383000\t/Applications/Asana.app'), 383000 * 1024, 'du -sk → bytes');
	assert.strictEqual(parseDuKApps('0\t/Applications/Safari.app'), 0, 'SIP app sizes to 0');
	assert.strictEqual(parseDuKApps('garbage'), 0, 'unparseable du → 0, never NaN');

	// mdls bundle id.
	assert.strictEqual(parseBundleId('kMDItemCFBundleIdentifier = "com.apple.Safari"'), 'com.apple.Safari', 'bundle id parsed');
	assert.strictEqual(parseBundleId('kMDItemCFBundleIdentifier = (null)'), null, 'null bundle id → null');

	// parseAppList: drops zero-size (SIP) rows, computes detail, sorts biggest-first.
	const list = parseAppList([
		{ name: 'Asana', path: '/Applications/Asana.app', bytes: 383000 * 1024, bundleId: 'com.electron.asana' },
		{ name: 'Safari', path: '/Applications/Safari.app', bytes: 0, bundleId: 'com.apple.Safari' },
		{ name: 'Tiny', path: '/Applications/Tiny.app', bytes: 10 * 1024 * 1024, bundleId: null },
	]);
	assert.strictEqual(list.length, 2, 'zero-size SIP app (Safari) dropped from the list');
	assert.strictEqual(list[0].name, 'Asana', 'biggest app sorts first');
	assert.ok(list[0].detail.includes('/Applications'), 'detail names the root');
	assert.ok(!list.find((a) => a.name === 'Safari'), 'Safari not present');

	// ---- 2. DESTRUCTIVE PATH — prove MOVE, not delete ------------------------------------
	// Build a throwaway fake bundle under os.tmpdir(). NEVER a real app path.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ramguard-apps-test-'));
	const fakeApp = path.join(tmp, 'RamGuardFakeApp.app');
	fs.mkdirSync(path.join(fakeApp, 'Contents', 'MacOS'), { recursive: true });
	fs.writeFileSync(path.join(fakeApp, 'Contents', 'Info.plist'), '<plist></plist>');
	fs.writeFileSync(path.join(fakeApp, 'Contents', 'MacOS', 'RamGuardFakeApp'), 'binary');
	assert.ok(fs.existsSync(fakeApp), 'fixture .app created');

	// Run the REAL move-to-Trash engine against the fixture.
	const trashedAt = await moveToTrash(fakeApp);

	// INVARIANT: the source is gone (moved away) and the item now lives in the Trash.
	assert.ok(trashedAt, 'moveToTrash returned a Trash path');
	assert.ok(!fs.existsSync(fakeApp), 'PROOF OF MOVE: source bundle is gone from its original location');
	assert.ok(fs.existsSync(trashedAt), 'PROOF OF NO-DELETE: the bundle is present in the Trash, not destroyed');
	assert.ok(trashedAt.includes(path.join(os.homedir(), '.Trash')), 'item landed under ~/.Trash');

	// uninstallApp must REFUSE a bundle that is not under an allowed app root — the allowlist
	// guard. We assert refusal using the temp path (out of /Applications), so this test never
	// trashes a real app.
	const refused = await uninstallApp({
		name: 'RamGuardFakeApp',
		path: fakeApp, // under os.tmpdir(), NOT under /Applications or ~/Applications
		bytes: 1024,
		mb: 1,
		detail: 'test',
		bundleId: null,
	});
	assert.strictEqual(refused.ok, false, 'uninstallApp refuses a path outside the allowed app roots');
	assert.strictEqual(refused.trashedPaths.length, 0, 'refused uninstall trashes nothing');

	// findAppLeftovers must only return paths that exist; a bogus app yields an empty list and
	// never throws.
	const leftovers = await findAppLeftovers({
		name: 'NoSuchAppXYZ123',
		path: '/Applications/NoSuchAppXYZ123.app',
		bytes: 1,
		mb: 0,
		detail: 'test',
		bundleId: 'com.example.nosuchapp.xyz123',
	});
	assert.ok(Array.isArray(leftovers), 'findAppLeftovers returns an array');
	assert.strictEqual(leftovers.length, 0, 'no leftovers exist for a bogus app');

	// ---- 3. CROSS-VOLUME (EXDEV) MUST NOT LIE ABOUT FREEING SPACE ------------------------
	// Regression for the audit finding: when the .app lives on a different volume than ~/.Trash,
	// the old EXDEV branch COPIED the bundle into Trash and returned the Trash path as "success"
	// while NEVER removing the original — so uninstallApp reported ok:true + freedBytes while the
	// app stayed fully installed. We simulate EXDEV by forcing fs.renameSync to throw {code:'EXDEV'}
	// and assert the new contract: moveToTrash must NOT report success unless the ORIGINAL is gone.
	const exdevSrc = path.join(tmp, 'ExdevFakeApp.app');
	fs.mkdirSync(path.join(exdevSrc, 'Contents'), { recursive: true });
	fs.writeFileSync(path.join(exdevSrc, 'Contents', 'Info.plist'), '<plist>exdev</plist>');
	assert.ok(fs.existsSync(exdevSrc), 'EXDEV fixture .app created');

	const realRename = fs.renameSync;
	fs.renameSync = function () {
		const e = new Error('cross-device link not permitted');
		e.code = 'EXDEV';
		throw e;
	};
	let exdevResult;
	try {
		exdevResult = await moveToTrash(exdevSrc);
	} finally {
		fs.renameSync = realRename; // ALWAYS restore, even if the assert below throws.
	}

	// The source is under os.tmpdir() (boot volume), so it cannot be relocated to a non-boot
	// volume's .Trashes — the honest outcome is a reported FAILURE, never a fake success.
	assert.strictEqual(exdevResult, null, 'EXDEV: moveToTrash returns null when the original cannot be relocated');
	assert.ok(fs.existsSync(exdevSrc), 'EXDEV: the ORIGINAL is NOT destroyed when relocation fails');

	// A recovery copy may have been staged in ~/.Trash (copy-first). Clean it up if present so we
	// never leave a stray artifact. The Trash copy keeps the bundle basename.
	const exdevTrashCopy = path.join(os.homedir(), '.Trash', 'ExdevFakeApp.app');
	try { if (fs.existsSync(exdevTrashCopy)) { fs.rmSync(exdevTrashCopy, { recursive: true, force: true }); } } catch (_) { /* ignore */ }

	// And uninstallApp must surface that failure too: with EXDEV forced, it must NOT claim freed
	// bytes. We run it against an allowed-root-shaped guard using a path under /Applications would
	// trash a real app, so instead we assert the engine-level contract via moveToTrash above and
	// here assert uninstallApp refuses cleanly when the bundle path doesn't exist on disk.
	const ghost = await uninstallApp({
		name: 'GhostApp', path: '/Applications/GhostAppNope.app', bytes: 999, mb: 1, detail: 'test', bundleId: null,
	});
	assert.strictEqual(ghost.ok, false, 'uninstallApp reports ok:false for a non-existent bundle');
	assert.strictEqual(ghost.freedBytes, 0, 'uninstallApp credits 0 bytes when nothing was trashed');

	// ---- CLEANUP: remove the Trash artifact and the temp dir. No real user data touched. ---
	try { fs.rmSync(trashedAt, { recursive: true, force: true }); } catch (_) { /* ignore */ }
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }

	console.log('OK — apps engine verified (parsers + move-to-Trash proven a MOVE, not a delete; EXDEV never fakes a free).');
})().catch((err) => {
	console.error('apps.selftest FAILED:', err);
	process.exit(1);
});
