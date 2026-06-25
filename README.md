# RAM Guard

A macOS **menu bar app** that shows your Mac's *true* memory pressure, frees RAM by quitting
the biggest apps, and cleans up disk space — junk, large old files, leftover apps, and noisy
login items — all from one window. **Every removal moves to the Trash; nothing is ever
hard-deleted, and nothing happens without a confirm dialog.**

It lives up by your clock as a `42%` pill. Two surfaces:

**The full window** (click the pill, or right-click → *Open RAM Guard*) — a 7-view dashboard:

- **Overview** — a health ring, memory/storage/junk/apps tiles, your heaviest apps, and a
  "Reclaim space" list.
- **Memory** — live memory use + the real compression pressure bar + the apps to quit.
- **Junk & Caches** — caches, logs, browser data, Trash — pick what to clear.
- **Large & Old Files** — big files in your common folders you haven't opened in 90+ days.
- **Applications** — installed apps by size, with **leftover-aware uninstall** (it trashes the
  app *and* its caches/prefs/support files).
- **Login Items** — what opens at startup, with a toggle to stop it (faster boot).
- **Storage** — a stacked bar of what's eating your disk.

**The pill panel** (right-click → *Memory panel*) — the original tiny glanceable panel:
memory bar, the macOS compression bar, and the biggest memory users with a **Quit** button.

> Built for someone who just wants their Mac to stop choking — no Activity Monitor spelunking.

## Why I built this

My Mac kept choking and the popular cleaner wanted 90 dollars a year. So instead of paying for it, I described what I wanted to an AI coding agent and had RAM Guard built, security-audited, and open-sourced in a day.

> Instead of paying for a bloated Mac cleaner, I used an AI coding agent to build a free open source RAM monitor in a day, proof you can build and own your own tools instead of renting them forever.

## Safety model (read this)

This app can move files to the Trash, so the guardrails matter:

- **Trash-only, never hard-delete.** Every clean / trash / uninstall routes through one shared
  `trashHelper()` that *moves* items to the Trash (Finder "delete", with a `~/.Trash` move as a
  fallback). There is zero `rm`/`unlink`/`fs.rm` on any user path anywhere in the code.
- **Confirm-first.** Every destructive action opens a dialog listing the **exact** items, paths,
  and sizes about to be touched, with **Cancel** as the default. Nothing acts until you confirm.
- **Allowlisted roots only.** Scanners only ever look at a fixed set of known folders
  (`~/Library/Caches`, `~/Library/Logs`, `~/.Trash`, `~/Downloads`, `~/Movies`, `~/Documents`,
  `~/Desktop`, `/Applications`, `~/Applications`) — never an arbitrary path.
- **Sandboxed UI.** The window runs with `contextIsolation`, no Node, a tight CSP, and a narrow
  preload bridge. Rows are built with `textContent`, so a booby-trapped filename can't run code.

---

## Run it (development)

```bash
npm install
npm start        # builds + launches the menu bar app
```

Look up by the clock — you'll see the percentage pill. Click it.

## Build a real app you can double-click

```bash
npm run dist     # → dist/mac/RAM Guard.app  (drag it to /Applications)
```

It has **no Dock icon** by design — it's menu bar only. To quit it, **right-click** the
pill → *Quit RAM Guard*.

## Verify the logic

```bash
npm test         # runs the parser self-checks under plain node (no display needed)
```

---

## How it works (the 30-second version)

```
menu bar pill "42%"  ←  vm_stat + ps every 5s
        click  →  full window  →  7 views
                     reads:  ram / storage / junk / large-files / apps / login-items engines
                     acts:   renderer → window.ram bridge → main confirm dialog → trashHelper (move to Trash)
```

- **Read path:** each view asks the main process for live data over the preload bridge
  (`window.ram.getStorage()`, `scanJunk()`, `scanLarge()`, `listApps()`, `listLogin()`), which
  runs the matching engine module. The engines spawn built-in macOS commands (`vm_stat`, `ps`,
  `df`, `du`, `find`, `mdls`, `system_profiler`, `osascript`), each timeout-guarded so one slow
  call degrades a view gracefully instead of hanging.
- **Action path:** every button (Quit / Clean / Trash / Uninstall / login toggle) calls a
  `window.ram.*` action, which the main process gates behind a confirm dialog listing exactly
  what's affected, then routes the move through the shared `trashHelper()` — Trash, never delete.
- **Quit** sends a polite `SIGTERM` to the heaviest process in an app's group, freeing the most
  memory immediately. It never force-kills.

## Files

| File | What it is |
|------|-----------|
| `src/ram.ts` | Memory engine — `vm_stat`/`ps` parsing. Pure Node, no UI. |
| `src/storage.ts` | Storage breakdown engine — `df`/`du`/`system_profiler` into a stacked bar. |
| `src/junk.ts` | Junk/caches scan + Trash-only clean (allowlisted roots). |
| `src/large-files.ts` | Large & old files scan + reveal + Trash. |
| `src/apps.ts` | Installed apps + leftover-aware uninstall to Trash. |
| `src/login-items.ts` | Login items list + toggle via System Events. |
| `src/main.ts` | Electron main — both windows, the tray, all IPC handlers, every confirm dialog, the shared `trashHelper`. |
| `preload.js` | The narrow, sandboxed bridge — the only door between the UI and Node. |
| `index.html` + `renderer.js` | The small pill panel UI (unchanged). |
| `window.html` + `window-renderer.js` | The full 7-view window UI, driven by real data. |
| `selftest*.js` | Runnable parser + move-not-delete checks under plain node (no display). |

## Notes & limits

- **macOS only.** The pressure math uses macOS commands; on other platforms it falls back to
  a rough estimate and the app isn't really meant for them.
- Quitting frees the most RAM in one shot but may not *gracefully* close a whole multi-process
  app. Good enough for "free RAM now"; a clean per-app quit is the obvious next upgrade.
- Lifted from the Ursula RAM Guard extension — same engine, no editor required.
