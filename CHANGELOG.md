# Changelog

## [2026-06-24] — v2.1 (security + correctness audit fixes)

### Fixed
- **Overview health banner now agrees with the ring.** It used to say "Your Mac is running
  clean" at 72% memory used (contradicting a low ring score). Now tiered off memory used:
  >=75% = "Your Mac needs attention", 46-74% = "Your Mac could be tidier", <=45% = "running
  clean". Why: a banner that lies about system health erodes trust in every other number. Bone+gold
  styling untouched. (`window-renderer.js`)
- **AppleScript injection in `login-items.ts` closed.** `trashLoginItemTarget()` was STRIPPING
  double-quotes from a path instead of escaping it, so a filename containing a backslash could
  break out of the AppleScript string and run arbitrary code. Now the path is escaped via
  `asStringLiteral()` (backslash THEN quote), and any path with a backslash/newline is hard-rejected
  before a script is built and routed to the pure-Node fs.rename fallback. (`src/login-items.ts`)
- **RAM engine can no longer freeze the menu-bar pill.** `getSystemRam()` (vm_stat) and
  `listTopProcesses()` (ps) — the only engines on the live 5s poll — had NO timeout. A hang under
  severe memory pressure would stall the pill forever and pile up child processes. Both now use the
  timer+SIGKILL+done-flag pattern (3s cap, fallback value on timeout), and `tick()` is now
  non-overlapping so a slow tick can't stack. (`src/ram.ts`, `src/main.ts`)
- **Cross-volume (EXDEV) uninstall no longer lies about freed space.** When an app lived on a
  different volume than ~/.Trash, the fallback COPIED the bundle into Trash and reported success
  while the original stayed fully installed. Now it stages a recovery copy, relocates the ORIGINAL
  into its own volume's `.Trashes`, and only credits freed bytes once the original is gone —
  otherwise returns null so the UI reports failure instead of a fake "freed 400 MB". (`src/apps.ts`)
- **Cleaning the Trash category now actually frees space.** It routed through `trashPath()`, which
  (because ~/.Trash is an allowed root) only renamed items WITHIN the Trash and still credited the
  bytes. Now the Trash category EMPTIES the Trash via Finder and credits only the bytes that truly
  left (re-measured before/after). Other categories now also credit the real before/after shrink
  instead of a blind estimate. (`src/junk.ts`)

### Added
- **Three regression tests** pinning the fixes: a backslash-path injection guard
  (`login-items.selftest.js`), an EXDEV "never fakes a free" assertion (`apps.selftest.js`), and a
  "trash category truly frees bytes" check with an injected sandbox-only emptier
  (`junk.selftest.js`). All run under plain `node` against throwaway `os.tmpdir()` fixtures.

## [2026-06-24] — v2 (full window)

### Added
- **Full CleanMyMac-style window** alongside the menu-bar pill — opened by clicking the tray
  pill or right-click → *Open RAM Guard*. Bone+gold theme, macOS chrome, 7 views: Overview,
  Memory, Junk & Caches, Large & Old Files, Applications, Login Items, Storage. Why: the pill
  is great for a glance, but freeing disk space and uninstalling apps needs room to see lists.
- **Five new engine views wired to real data** over the preload bridge — storage breakdown,
  junk/caches scan, large & old files, installed apps, and login items — each reading live from
  its engine module (`df`/`du`/`find`/`mdls`/`system_profiler`/`osascript`), all timeout-guarded.
- **Smart Scan** and **Free up** flows that kick off the real scans behind the existing
  progress animation, so the polished mockup motion now drives actual work.
- **Shared `trashHelper()` + confirm dialogs** for every destructive action (quit, clean junk,
  trash a large file, uninstall an app, toggle a login item). Each opens a dialog listing the
  exact items/paths/sizes with Cancel as the default before anything moves.

### Changed
- **Tray left-click now opens the full window** (the small pill panel moved to right-click →
  *Memory panel*). Why: the window is the primary surface now; the pill is the quick glance.
- **Renderer is sandboxed and externalized** — the window's script lives in
  `window-renderer.js` (CSP `script-src 'self'`), and every row is built with
  `createElement`/`textContent`, never `innerHTML` of a file/app/process name. Why: a
  booby-trapped filename must render as text, never run as markup.

### Security
- **Trash-only, never hard-delete.** Zero `rm`/`unlink`/`fs.rm` on any user path; the only
  filesystem mutation is a move (`fs.rename`) into the Trash, behind the Finder AppleEvent.
- **Allowlisted roots only** for every scanner and every trash move; paths are validated
  absolute + existing + under an allowed user root before anything is touched.

## [2026-06-24]

### Added
- First standalone release. Lifted the memory engine out of the Ursula RAM Guard VS Code
  extension and wrapped it in a menu bar app — so it runs for anyone, no editor required.
- Menu bar pill showing live memory use as a percent (warns at 88%), so it's glanceable.
- Click-for-panel: memory bar + the macOS compression bar (the real out-of-memory signal,
  not the optimistic "free RAM" number) + the apps eating the most memory.
- One-click "Quit" per app to free RAM fast, grouped by app so Chrome's many helper
  processes show as one row instead of flooding the list.

### Changed
- Generalized "Claude sessions" → "any app" — the original only watched Claude processes,
  which a non-developer doesn't run.
- "Quit" now asks for confirmation and warns to save first — quitting a normal app isn't
  "safe on disk" the way a Claude chat is, so it must not be one careless click.

### Removed
- All Claude/Ursula-specific features (session resume, transcript reveal, mid-turn crash
  recovery, the Lite/Terax optimizer) — dead weight outside the editor.
