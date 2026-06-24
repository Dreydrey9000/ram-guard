# Changelog

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
