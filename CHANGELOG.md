# Changelog

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
