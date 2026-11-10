# Changelog

## [Unreleased]

- Fixed `dispose` restoring `spawn` without clearing the `__utf8OutputBridged` marker: after a plugin hot reload the next `apply()` returned early and output silently fell back to mojibake. `dispose` now clears the marker too, so a reload takes over again while repeated `apply()` stays idempotent.
- Platform scope: `apply()` now installs the patch only on Windows (`process.platform === "win32"`); other platforms are a strict no-op, so Latin-1/CP1252 bytes are no longer decoded as GBK (`cafét` used to become `caf閠`).
- Docs and package description corrected: only GB18030/GBK/CP936 is implemented; Big5 (950) / CP932 / CP949 are no longer implied to work and keep the stock (mojibake) output.
- Known-limitation note: when a GBK window starts on the trail byte of the previous character and the fragment happens to be valid GBK itself (e.g. `d0 ce c4 61 62 63`), the alignment is undecidable; the plugin keeps the direct decode and does not guess with heuristics.

## 0.1.1 — 2026-11-07

Robustness fixes.

- Fixed duplicated head bytes when the collector window slides between `readFrom()` and the snapshot taken right after it; already-returned bytes are no longer sent twice.
- Fixed offset corruption when `snapshot().totalBytes` is smaller than the retained buffer (12 bytes of Chinese test text used to decode as a single character).
- Non-finite `fromByte` (NaN/undefined) now keeps the core result instead of re-sending the whole tail.
- A `spawn()` that returns a promise or thenable is patched after it settles (previously the plugin silently did nothing for those cores).
- Added `ctx.on("dispose")` to restore `spawn`, so reloading/unloading leaves no stale wrapper and no bridge marker blocking the next instance.
- Failure paths are no longer silent: a frozen service, a failed `spawn` replacement or a re-decode error each report one warning.
- Performance: edge truncation is now a byte-level check with reused `TextDecoder`s and a one-entry memo per collector; 2000 consecutive reads of a 2.8KB window dropped from 168ms to 20ms.
- Tests grew from 19 to 25, covering the window race, malformed metadata, a frozen service, a promise-returning handle and dispose.

## 0.1.0 — 2026-11-07

First release.

- Decodes subprocess output from the retained raw bytes by hooking `OutputCollector.readFrom()` / `finalize()` on the cordis `subprocess` service, fixing GBK/CP936/CP932 mojibake on Windows.
- Decoding strategy: strict UTF-8 → edge-truncation tolerance → GB18030 with realignment → fallback.
- Works on early cores without `snapshot()` by reading the `chunks` / `total` fields.
- Byte-identical for pure UTF-8 / ASCII; patching and `apply()` is idempotent.
- 19 unit tests covering decode decisions and service wiring.
