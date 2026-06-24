# RAM Guard

A tiny macOS **menu bar app** that shows your Mac's *true* memory pressure and lets you free
RAM by quitting the biggest apps — in one click.

It lives up by your clock as a `42%` pill. Click it for a small panel:

- **Memory used** — how full your RAM is.
- **Compression (real pressure)** — the macOS signal that actually predicts a slowdown/freeze.
  When this climbs, your Mac is about to start thrashing. The plain "free RAM" number hides this.
- **Biggest memory users** — the apps eating the most memory, each with a **Quit** button
  (with a confirm, so you don't close something with unsaved work).

> Built for someone who just wants their Mac to stop choking — no Activity Monitor spelunking.

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
vm_stat + ps  →  every 5s  →  menu bar pill "42%"
       click  →  panel  →  [memory bar] [compression bar] [top apps] → Quit (confirm)
```

- `vm_stat` (a built-in macOS command) gives the true memory picture, including the
  *compressor* — the strongest single sign that you're running out of RAM.
- `ps` lists every process and its memory; the app groups them by their parent app (so
  Chrome's 30 helper processes become one summed "Google Chrome" row) and shows the top 8.
- **Quit** sends a polite shutdown signal (`SIGTERM`) to the heaviest process in that group,
  freeing the most memory immediately. It never force-kills.

## Files

| File | What it is |
|------|-----------|
| `src/ram.ts` | The memory engine — `vm_stat`/`ps` parsing. Pure Node, no UI. |
| `src/main.ts` | The Electron menu bar app — the pill, the panel, the quit confirm. |
| `preload.js` | The narrow, sandboxed bridge between the panel and Node. |
| `index.html` + `renderer.js` | The panel UI. |
| `selftest.js` | Runnable checks for the parsers. |

## Notes & limits

- **macOS only.** The pressure math uses macOS commands; on other platforms it falls back to
  a rough estimate and the app isn't really meant for them.
- Quitting frees the most RAM in one shot but may not *gracefully* close a whole multi-process
  app. Good enough for "free RAM now"; a clean per-app quit is the obvious next upgrade.
- Lifted from the Ursula RAM Guard extension — same engine, no editor required.
