# RAM Guard

A tiny (~1.7 MB) **native** macOS menu bar app that shows your Mac's *true* memory pressure,
warns you when you cross a memory limit **you** set, frees RAM by quitting the biggest apps, and
cleans up disk space — junk, large old files, leftover apps, and noisy login items — from one
window. **Every removal moves to the Trash; nothing is ever hard-deleted, and nothing happens
without a confirm dialog.**

Built in Swift / SwiftUI. It lives up by your clock as a `42%` pill. Two surfaces:

**The pill panel** (click the menu-bar pill) — a compact, glanceable popover: the live memory bar,
the real compression pressure, your biggest memory users with a **Quit** button, an **Alert above
__%** slider (your memory limit), and **Free up RAM**.

**The full window** (click the dock icon) — a big, resizable, CleanMyMac-style window with a left
sidebar and six sections:

- **RAM** — live memory use + true compression pressure + the apps to quit + your alert slider.
- **Junk** — caches, logs, browser data, Trash — pick what to clear.
- **Large Files** — big files (100 MB+) in your common folders you haven't opened in 90+ days.
- **Apps** — installed apps by size, with **leftover-aware uninstall** (it trashes the app *and*
  its caches/prefs/support files).
- **Login Items** — what opens at startup, with a toggle to stop it (faster boot).
- **Storage** — a stacked bar of what's eating your disk.

### Memory-limit alerts

Set a line on the **Alert above __%** slider (default 85%). When your memory crosses it, the pill
goes **red** with a `! NN%`, the bar turns red, and an **"Over your NN% limit"** banner appears with
a one-tap **Free up**. It fires *once* per real crossing (hysteresis — it re-arms only after you
drop back under), so it warns you without nagging. A note on what's possible: macOS can't *hard-cap*
total RAM (that would need a kernel extension, which Apple Silicon doesn't allow) — so RAM Guard
warns and gives you a one-click fix, which is the real-world version of "keep me under my limit".

> Built for someone who just wants their Mac to stop choking — no Activity Monitor spelunking.

## Why I built this

My Mac kept choking and the popular cleaner wanted 90 dollars a year. So instead of paying for it, I described what I wanted to an AI coding agent and had RAM Guard built, security-audited, and open-sourced in a day.

> Instead of paying for a bloated Mac cleaner, I used an AI coding agent to build a free open source RAM monitor in a day, proof you can build and own your own tools instead of renting them forever.

## Safety model (read this)

This app can move files to the Trash and quit apps, so the guardrails matter:

- **Trash-only, never hard-delete.** Every clean / trash / uninstall routes through the native
  `FileManager.trashItem` API — a *move* to the Trash with macOS put-back, recoverable. There is
  zero `rm`/`unlink` on any user path anywhere in the code. (Emptying the Trash is the one exception,
  and it goes through Finder.)
- **Confirm-first.** Every destructive action opens a dialog naming the **exact** items, paths, and
  sizes about to be touched, with **Cancel** as the default. Nothing acts until you confirm.
- **Allowlisted, symlink-safe roots only.** Scanners only ever touch a fixed set of known folders
  (`~/Library/Caches`, `~/Library/Logs`, `~/.Trash`, `~/Downloads`, `~/Movies`, `~/Documents`,
  `~/Desktop`, `~/Music`, `~/Pictures`, `/Applications`, `~/Applications`). Every path is resolved
  through its symlinks before the allowlist check, and symlinked items are skipped — so nothing can
  smuggle a path out of the allowlist.
- **No false alarms, no kill-loops.** Memory pressure comes straight from the kernel
  (`host_statistics64`, compression included), so it never shows a false 100%. The quit path
  re-validates each process's kernel start-time before signaling, so a recycled PID can't be hit.

## Build it

```bash
cd native
./build.sh install      # compiles, bundles "RAM Guard.app", ad-hoc signs, installs to /Applications, relaunches
./build.sh              # build + bundle only (no install)
```

Requires the Xcode command-line tools (`swiftc`). The app is **menu bar + window**; the pill lives by
your clock, and the full window opens from the dock icon.

### Verify the safety logic

```bash
cd native
d=/tmp/rgtest_build; mkdir -p $d; cp selftest.swift $d/main.swift
swiftc Common.swift DiskEngines.swift $d/main.swift -o /tmp/rgtest && /tmp/rgtest
# prints "ALL DISK CHECKS PASSED" — proves Trash-only, the allowlist (incl. symlink-escape), and the parsers
```

### Installing on another Mac

RAM Guard is **ad-hoc signed**, not yet notarized, so the first time you open it on another Mac,
**right-click the app → Open** to clear Gatekeeper. Notarization (for friction-free distribution)
needs an Apple Developer ID — `native/notarize.sh` runs the whole sign + submit + staple in one
command once that cert exists.

## Files (native)

| File | What it is |
|------|-----------|
| `native/RAMGuard.swift` | RAM engine (`host_statistics64` + `ps`), the kill path, the threshold alert, the menu-bar Dashboard, and the sidebar `MainWindow`. |
| `native/DiskEngines.swift` | The five disk engines — junk, large-files, apps, login-items, storage. Pure logic, fixture-tested. |
| `native/DiskViews.swift` | The five disk views + the shared dark-theme components. |
| `native/Common.swift` | Shared shell runner (timeout-guarded), the Trash helper, and the symlink-safe path allowlist. |
| `native/App.swift` | The `@main` entry — the window + the menu-bar extra. |
| `native/selftest.swift` | Runnable safety + parser checks (Trash-only proof, allowlist, symlink-escape). |
| `native/build.sh` / `native/notarize.sh` | One-command build/install, and the ready-to-run notarize pipeline. |

> The original Electron version lives under `src/` (legacy). The native Swift app above supersedes it.

## Notes & limits

- **macOS only**, Apple Silicon target. Needs macOS 14+.
- Quitting an app frees the most RAM in one shot by SIGTERM-ing its whole process group.
- macOS can't enforce a hard memory ceiling for apps it didn't launch — RAM Guard's limit is a
  warn-and-act alert, not a kernel-level cap.
