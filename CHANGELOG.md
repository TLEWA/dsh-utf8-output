# Changelog

## [Unreleased]

- 接入 Codex PR 公共审阅规则与本仓重点，保留现有 CI、人工批准和发布行为。

未发布修复 / Unreleased fixes.

- 修复 `dispose` 只还原 `spawn`、没有清除 `__utf8OutputBridged` 的问题：插件热重载后第二次 `apply()` 会直接返回，子进程输出静默退回乱码。现在 `dispose` 同时清除桥接标记，重新加载会再次接管；重复 `apply()` 仍保持幂等。
- 平台范围：`apply()` 现在只在 Windows（`process.platform === "win32"`）安装补丁；其他平台是纯 no-op，不再把 Latin-1/CP1252 字节按 GBK 解码（`cafét` 之前会变成 `caf閠`）。
- 文档与包描述修正：明确只实现 GB18030/GBK/CP936，不再暗示支持 Big5（950）/CP932/CP949；这些代码页保持内核原样输出（乱码），不会用 GB18030 猜解。
- 已知限制补充：GBK 窗口首字节是上一字符的 trail 字节、残片又能自成一个合法字符时（如 `d0 ce c4 61 62 63`），没有可靠判据区分错位；插件保持直接解码结果，不用启发式猜解。

- Fixed `dispose` restoring `spawn` without clearing the `__utf8OutputBridged` marker: after a plugin hot reload the next `apply()` returned early and output silently fell back to mojibake. `dispose` now clears the marker too, so a reload takes over again while repeated `apply()` stays idempotent.
- Platform scope: `apply()` now installs the patch only on Windows (`process.platform === "win32"`); other platforms are a strict no-op, so Latin-1/CP1252 bytes are no longer decoded as GBK (`cafét` used to become `caf閠`).
- Docs and package description corrected: only GB18030/GBK/CP936 is implemented; Big5 (950) / CP932 / CP949 are no longer implied to work and keep the stock (mojibake) output.
- Known-limitation note: when a GBK window starts on the trail byte of the previous character and the fragment happens to be valid GBK itself (e.g. `d0 ce c4 61 62 63`), the alignment is undecidable; the plugin keeps the direct decode and does not guess with heuristics.

## 0.1.1 — 2026-11-07

健壮性修复 / Robustness fixes.

- 修复窗口滑动竞态导致的头部重复输出：窗口在 `readFrom()` 与快照之间前进时，不再把已经返回的字节重发一遍。
- 修复 `snapshot().totalBytes` 小于保留字节数时的偏移错乱（12 字节的「测试中文」曾被解成「文」）。
- `fromByte` 为非有限值（NaN/undefined）时保留内核原始结果，不再整段重发。
- `spawn()` 返回 Promise/thenable 时，在它 settle 之后再补挂 collector（此前整插件会静默失效）。
- 新增 `ctx.on("dispose")` 还原 `spawn`：插件重载/卸载后不再残留旧包装，也不会被桥接标记挡住。
- 失败路径不再静默：服务冻结、`spawn` 替换失败、重解码异常都会报告一次 warn。
- 性能：边缘截断改为字节级判断并复用 `TextDecoder`，相同的读取走单条 memo；2.8KB 窗口连续读取 2000 次从 168ms 降到 20ms。
- 测试从 19 个增至 25 个，覆盖竞态、异常元数据、冻结服务、Promise handle 与 dispose。

- Fixed duplicated head bytes when the collector window slides between `readFrom()` and the
  snapshot taken right after it; already-returned bytes are no longer sent twice.
- Fixed offset corruption when `snapshot().totalBytes` is smaller than the retained buffer
  (12 bytes of 「测试中文」 used to decode as 「文」).
- Non-finite `fromByte` (NaN/undefined) now keeps the core result instead of re-sending the whole tail.
- A `spawn()` that returns a promise or thenable is patched after it settles (previously the plugin
  silently did nothing for those cores).
- Added `ctx.on("dispose")` to restore `spawn`, so reloading/unloading leaves no stale wrapper and no
  bridge marker blocking the next instance.
- Failure paths are no longer silent: a frozen service, a failed `spawn` replacement or a re-decode
  error each report one warning.
- Performance: edge truncation is now a byte-level check with reused `TextDecoder`s and a one-entry
  memo per collector; 2000 consecutive reads of a 2.8KB window dropped from 168ms to 20ms.
- Tests grew from 19 to 25, covering the window race, malformed metadata, a frozen service, a
  promise-returning handle and dispose.

## 0.1.0 — 2026-11-07

首个版本 / First release.

- 通过 cordis `subprocess` 服务接管 `OutputCollector.readFrom()` / `finalize()`，
  用保留的原始字节重新解码，修复 Windows 上 GBK/CP936/CP932 子进程输出乱码。
- 解码策略：严格 UTF-8 → 边缘截断宽容 → GB18030（必要时重对齐）→ 原样回退。
- 兼容没有 `snapshot()` 的早期内核：回退读取 `chunks` / `total` 字段。
- 纯 UTF-8 / ASCII 输出逐字节不变；patch 与 `apply()` 幂等。
- 19 个单元测试覆盖解码判定与服务接线。

- Decodes subprocess output from the retained raw bytes by hooking
  `OutputCollector.readFrom()` / `finalize()` on the cordis `subprocess` service, fixing
  GBK/CP936/CP932 mojibake on Windows.
- Decoding strategy: strict UTF-8 → edge-truncation tolerance → GB18030 with realignment → fallback.
- Works on early cores without `snapshot()` by reading the `chunks` / `total` fields.
- Byte-identical for pure UTF-8 / ASCII; patching and `apply()` are idempotent.
- 19 unit tests covering decode decisions and service wiring.
