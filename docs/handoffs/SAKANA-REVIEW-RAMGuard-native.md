# Sakana (Fugu) Adversarial Review — RAM Guard native (Swift)

Run 2026-06-27 via `mcp__sakana__ask_sakana` (model `fugu`, reasoning high) against `native/RAMGuard.swift`.
Captured: 2 Critical + 3 High in full; Medium/Low truncated by the token cap.

## CRITICAL

### C1 — `quit()` can kill a RECYCLED pid (wrong process / data loss)
PIDs are captured during a `tick()` up to 5s before the click. The kernel can recycle a dead pid onto a brand-new process (an editor, a build job) in that window, so `kill(p.id, SIGTERM)` hits an innocent process.
**Fix:** capture the process start-time at scan, re-validate identity right before signaling (`proc_pidinfo`/`sysctl(KERN_PROC_PID)` `p_starttime`), abort + re-tick if it changed. Surface `errno` (ESRCH/EPERM) from `kill`.

### C2 — "Quit Chrome" kills one helper, not the app (the UI lies)
We group by app name and SUM rss for display, but store only the single biggest pid — usually a Chrome renderer/GPU helper, not the main process. SIGTERM kills a tab; Chrome respawns it; the user thinks 4 GB was freed and nothing happened.
**Fix:** carry ALL pids in the group and signal the group (or target the parent via `ps -axo pid=,ppid=,...` so the root tears down its children).

## HIGH

### H1 — No timeout on the `Process` calls (regression from the Electron build)
`vm_stat`/`ps` normally return fast, but under the exact memory pressure this tool targets, `fork`/`exec` can stall. `readDataToEndOfFile()` + `waitUntilExit()` with no deadline = a wedged worker thread, and `tick()` every 5s can pile up stuck threads. (Read-then-wait ordering is also latently deadlock-prone on large output.)
**Fix:** restore a timeout + `terminate()`/SIGKILL guard, OR drop the subprocess entirely and use `host_statistics64(HOST_VM_INFO64)` / `sysctl`.

### H2 — Timer is never stored or invalidated
`Timer.scheduledTimer` is added to the current run loop; if the engine is ever created off-main it silently never fires, and with `[weak self]` the engine can dealloc leaving an orphan timer firing forever.
**Fix:** store `private var timer`, `deinit { timer?.invalidate() }`, ensure init on main (or use a `DispatchSourceTimer`).

### H3 — `readRam()` math: false 100% on empty output + unused compressor
- If `vm_stat` returns "" (e.g. an H1 timeout), every page count is 0 → `free=0` → `used=total` → **usedPct=100**, falsely showing max pressure and triggering panic-quits.
- `compressorMb` is computed but never used in the pressure number — dead code, an unfinished port; compressed pages ARE pressure.
- Counting inactive/purgeable as free under-reports pressure.
**Fix:** use `host_statistics64` for true pressure; failing that, return a sentinel (show "—", not 100%) when output is empty, and factor the compressor in.

## MEDIUM / LOW
Truncated by the response cap (started: "M1 — freeUp blindly kills top 2…"). Re-run Sakana for the full medium/low tier if wanted.

---
**Verdict:** the native UI/shell is solid, but the kill path (C1, C2) and the false-100%/no-timeout robustness (H1, H3) are must-fix before this is reliable for anyone but a careful user. The Electron build had the timeout guard + the same pid-by-value kill (so C1/C2 apply there too).
