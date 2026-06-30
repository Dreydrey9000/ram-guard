# Changelog

## [2026-06-30] — memory-limit alerts + first commit of the native source

### Added — set a memory line, get warned when you cross it
- **Threshold slider** in the RAM view (and menu-bar popover): "Alert above [50–95%]", persisted via
  `@AppStorage`/UserDefaults (default 85%).
- **Crossing the line warns you** three guaranteed ways: the menu-bar pill goes red + shows `! NN%`,
  the bar/gauge turn red, and an in-app **"Over your NN% limit"** banner appears with a one-tap
  "Free up". The pill's red state is now tied to *your* number, not a hardcoded 88%.
- **Hysteresis, not flapping** (`RamEngine.checkThreshold`): fires once on a real upward crossing,
  re-arms only after usage drops 5% below the line. Does NOT fire on launch-while-already-high or
  when you drag the slider (re-seeds silently). A dock bounce (`requestUserAttention`) is the active
  nudge; a `UNUserNotificationCenter` system notification is best-effort on top.

### Decided (skeptic pass, then revised)
- **No auto-quit.** A skeptic review flagged that "auto free up when over" can cascade-kill apps
  (quitting 2 apps doesn't guarantee a drop below the line → next tick quits 2 more → loops, data
  loss). Dropped it; the warning + one-tap "Free up" is the safe, sufficient design.
- **Notifications are pill+banner+dock-bounce first.** `UNUserNotificationCenter` silently no-ops on
  an ad-hoc-signed app (auth returns granted, `usernoted` drops it), so it's a bonus, never relied on.

### Signing / notarization — honest status
- App is **ad-hoc signed** (runs locally; others must right-click → Open to bypass Gatekeeper).
- **Notarization is blocked on Apple Developer enrollment** — this machine has 0 signing identities /
  0 Developer ID certs. It needs a paid membership ($99/yr) + a Developer ID Application cert +
  notarytool credentials. `native/notarize.sh` is written and ready to run the moment those exist.

### Repo
- First commit of the `native/` Swift source (was untracked). Build artifacts (`native/RAMGuard`,
  `native/RAM Guard.app/`) gitignored. `native/` supersedes the Electron `src/`; committed to the
  local branch only — the public repo flip is still a separate, pending decision.

## [2026-06-27] — native v2 (Sakana criticals fixed + disk views ported)

### Fixed (Sakana adversarial review — `native/RAMGuard.swift`)
- **C1 — pid-reuse can no longer kill the wrong process.** Each app group now carries every pid
  with its kernel start-time (`sysctl KERN_PROC_PID` `p_starttime`). Right before a `kill`, the
  start-time is re-validated; if the pid was recycled onto a new process (or already died), it's
  skipped. `kill` failures surface `errno` (ESRCH/EPERM) to stderr. Why: PIDs captured during a
  5s tick could be recycled before the click, sending SIGTERM to an innocent editor/build job.
- **C2 — "Quit Chrome" now quits Chrome, not one helper.** App rows store ALL pids in the group
  (parent + every renderer/GPU helper) and signal the whole group, instead of just the single
  biggest pid. Why: killing one renderer freed nothing while the UI claimed it freed GBs.
- **H1 — subprocess calls are timeout-guarded.** `shell()` reads on a background thread with a
  deadline and `terminate()`+SIGKILL fallback, so a wedged `ps`/`du` under memory pressure can't
  strand a worker thread. The RAM read no longer shells out at all (see H3).
- **H2 — the poll Timer is stored + invalidated.** `private var timer` + `deinit { timer?.invalidate() }`
  so a deallocated engine can't leave an orphan timer firing forever.
- **H3 — no more false 100%.** RAM pressure now comes straight from the kernel
  (`host_statistics64 HOST_VM_INFO64`) and **counts the compressor** (used = wired + compressed +
  app memory, ~Activity Monitor "Memory Used"). On any read failure it shows "—", never a false
  100% that could trigger panic-quits. Verified: matches raw `vm_stat` (16 GB compressor on a
  pressured 36 GB machine = 86% used, which the old inactive-as-free math hid).

### Added
- **Disk views ported from Electron to native Swift** (`native/Common.swift`, `DiskEngines.swift`,
  `DiskViews.swift`): Junk (caches/logs/browser/Trash), Large & Old Files (100MB+/90d+), Uninstall
  Apps (bundle + leftovers), Login Items, Storage breakdown. The window is now a TabView (RAM +
  5 disk tabs); the menu-bar pill stays RAM-only and lean.
- **Trash-only guarantee, the native way.** Every destructive path uses `FileManager.trashItem`
  (recoverable, macOS put-back, collision-safe) — there is no `rm`/`unlink` anywhere. Replaces
  ~400 lines of Electron osascript+rename+EXDEV handling. Empty-Trash (the one reclaim case) still
  routes through Finder. Each engine validates an allowlist before any move.
- **`native/selftest.swift`** — proves the Trash-only property (file lands in ~/.Trash, source
  gone), the allowlist (rejects `/etc/passwd` + segment-boundary tricks), and all pure parsers.
  19/19 pass. **Run before shipping any disk-engine change.**
- **`native/build.sh`** — one command to compile (`swiftc native/*.swift`), bundle, ad-hoc sign,
  and `install` to /Applications.

### Hardened (Sakana fugu-ultra adversarial pass, round 2)
Ran a second Sakana review against the criticals fixes + the new disk engines. Verified each
finding against the real code (two "criticals" were partly overstated — the leftover delete was
already allowlist-gated), applied the genuine ones:
- **`Paths.isUnder` now resolves symlinks** (`resolvingSymlinksInPath` both sides) so an
  intermediate symlink can't smuggle a path out of the allowlist. Root cause behind several findings.
- **JunkEngine cleans per-item, not per-dir** — each child is symlink-skipped (`isSymlink`, lstat)
  and re-checked with `isUnder`, instead of trusting the parent dir's check.
- **Large-files `validTarget` rejects symlinks.**
- **Bundle-id sanitized** before path interpolation in app-uninstall leftovers (no `/` or `..`).
- **Login `safeName` rejects all newlines/control chars** (incl. U+2028/U+2029/U+0085) — closes the
  osascript string-literal break-out. Self-test grew a symlink-escape regression; 21/21 pass.
  (Accepted as low-risk on a single-user local tool: live-cache deletion is inherent to cache
  cleaning — mitigated by Trash-recoverable + confirm; TOCTOU file-swap needs local write access.)

### Fixed + redesigned — UI was white-on-white in Dark Mode
- **Bug:** disk-view rows used bare `Text(...)` with no color, inheriting the system label color =
  WHITE in macOS Dark Mode, on a hardcoded light background → invisible "Quit"/file names (Drey
  couldn't read what he'd be quitting).
- **Fix (root cause):** forced `.preferredColorScheme(.dark)` + explicit colors on every label, so
  no text depends on system appearance anymore.
- **Redesign (dark "command deck"):** repainted to RAM Guard's own handoff palette — charcoal
  `#0B0B0D`, bone `#F4F1EC` text, gold `#D1B47F` accent, warm-red `#E96F56` danger. Panel-card rows
  with depth, an animated glowing gold RAM bar, reusable `GhostButton` (gold / danger ghost) +
  `PrimaryButton` (gold fill, ink text), hover states. Quit/Trash/Uninstall now clearly readable;
  destructive actions tinted red. Bone-on-charcoal ≈ 15:1 contrast (WCAG AAA).
- Split `@main` into `App.swift` so the views compile into an offline `ImageRenderer` harness —
  visually verified to PNG (no Screen Recording permission needed).

### Added — big resizable window (CleanMyMac-style)
- Replaced the cramped 460×540 tab strip with a **large, resizable, floating window**: a left
  sidebar (app title + always-on memory gauge + 6 nav sections with gold-highlighted selection) and
  a big content area. Default 980×680, min 860×580, freely resizable.
- Engines hoisted to `MainWindow` and **injected** into each view (`@ObservedObject`, not
  `@StateObject`), so switching sections preserves each section's scan state — no re-scan per click.
- The menu-bar extra stays the compact 380×470 RAM popover (`Dashboard` made flex-frame; pinned to
  380×470 only at the menu-bar call site). Verified via offline `ImageRenderer` of the full window.

### Not done / caveats
- Live window verified by offline render (full sidebar window + disk rows) + clean launch. Drey:
  glance at the running app to confirm the menu-bar popover + the live process list in the RAM tab
  (the offline renderer can't lay out ScrollViews — live it fills with processes).
- App is ad-hoc signed, local, not notarized. `native/` source still uncommitted; public repo main
  still shows the Electron code.
- Empty-Trash + Login-Items need macOS Automation permission (Finder/System Events) — prompts once.

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
