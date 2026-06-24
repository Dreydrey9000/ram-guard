# Changelog

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
