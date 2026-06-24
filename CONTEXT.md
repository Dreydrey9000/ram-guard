# CONTEXT — RAM Guard v2 (CleanMyMac-style window app)

The fence for an agentic build loop. Locked 2026-06-24 after wireframe + clickable mockup approval.

## What we're building
A full-window macOS app ("see everything, simple") that lives in the SAME Electron app as the
existing menu-bar pill and reuses the same engine (`src/ram.ts`). The tray pill stays; a new
"Open RAM Guard" menu item opens the big window. One app, two entry points, one engine.

## Locked design
- Approved clickable mockup: `scratchpad/mockup.html` — light "bone + gold" theme, macOS window chrome.
- Sidebar: Overview / Memory / Junk & Caches / Large & Old Files / Applications / Login Items / Storage,
  plus a main panel. Overview = one health verdict + Smart Scan.

## THE FENCE — this loop is CLOSED, not roaming

### Phase 1 — SAFE. Build now. (read-only + the one existing safe mutation)
IN scope:
- Overview, Memory, Storage views wired to REAL data from `src/ram.ts`.
- Extend `ram.ts` with a storage breakdown (`df -k` / `system_profiler SPStorageDataType`).
- Promote `mockup.html` into the real renderer (data over IPC via `preload.js`; contextIsolation on, no nodeIntegration).
- "Quit app" stays — it is already confirm-guarded and is the ONLY mutation allowed in Phase 1.
OUT of scope for Phase 1 (stub or hide):
- Junk & Caches cleaning, Large & Old Files delete, Applications uninstall, Login Items writes.

### Phase 2 — DESTRUCTIVE. NOT in an autonomous loop.
Anything that DELETES or MODIFIES the user's files/system is built human-in-the-loop with hard guardrails:
- Move to Trash, NEVER hard-delete. Show exactly what will be removed BEFORE doing it.
- No "clean all" without an explicit, per-run confirm.
- Reason: a roaming agent with delete power is the #1 vibe-coding disaster (e.g. Replit deleting a
  production DB). This stays fenced off from any set-and-forget run.

## Verify gate — every loop step must pass
build (`tsc`) green → `selftest.js` passes → app launches clean → real data renders →
screenshot matches the approved mockup → adversarial check: NO Phase-2 destructive code path is
reachable in this build.

## Decisions
- Theme: light bone + gold (confirmed via mockup approval 2026-06-24).
- One repo, shared engine, tray + window in one Electron app.
- Phase 1 has no blocking open questions.
