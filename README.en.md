# dsh-utf8-output

[![CI](https://github.com/TLEWA/dsh-utf8-output/actions/workflows/ci.yml/badge.svg)](https://github.com/TLEWA/dsh-utf8-output/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-utf8-output.svg)](https://www.npmjs.com/package/dsh-utf8-output)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[简体中文](README.md) · [English](README.en.md)

Fixes mojibake in [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) subprocess output on Windows.

What it looks like without the plugin:

```text
����λ�� ��:1 �ַ�: 134
+ ... lect-Object ProcessId,CreationDate,@{n='MB';e={[math]::Round(/usr/bin ...
```

With the plugin the same command reads normally:

```text
所在位置 行:1 字符: 134
+ ... lect-Object ProcessId,CreationDate,@{n='MB';e={[math]::Round($_.WorkingSetSize/1MB)}} ...
```

## Root cause

The DSH subprocess service (`@deepseek-ai/dsh-subprocess-local`) decodes the **raw bytes** of a
child's stdout/stderr with a bare `Buffer#toString("utf8")`:

```js
readFrom(fromByte) {
  return { text: buffer.toString("utf8"), ... };
}
```

On Windows, programs under `cmd.exe` / `powershell.exe` usually emit their **OEM code page**:

| System language | Code page | Encoding |
| --- | --- | --- |
| Simplified Chinese | 936 | GBK |
| Traditional Chinese | 950 | Big5 |
| Japanese | 932 | CP932 |
| Korean | 949 | CP949 |

> The plugin implements **936 / GBK / GB18030 / CP936** only. There is no decoder for 950 (Big5),
> 932 (CP932) or 949 (CP949): output in those code pages keeps the stock result (mojibake) and is
> never guessed as GB18030, so no new wrong characters are introduced.

Those bytes are not valid UTF-8, so every illegal sequence becomes `U+FFFD` (`�`) and the original
information is irreversibly lost. The bug is neither in the bash tool nor in the command itself.

## How it works

The plugin does not modify any core file. It hooks the cordis `subprocess` service:

1. `apply(ctx)` grabs the `subprocess` service and wraps its `spawn()`;
2. every handle exposes `handle.collected.stdout` / `.stderr` — `OutputCollector` instances that
   keep the raw chunks;
3. the plugin replaces their `readFrom()` and `finalize()` so the retained bytes are re-decoded
   before anything upstream sees the text.

Decoding order:

| Step | Test | Result |
| --- | --- | --- |
| 1 | strict UTF-8 (`fatal: true`) decodes | returned as-is, byte-identical |
| 2 | only the window edges are cut (≤3 stray bytes), the rest is clean UTF-8 | lenient UTF-8 (one `U+FFFD` at the edge) |
| 3 | GB18030 decodes strictly (skipping 1–3 misaligned bytes if needed) | decoded as GBK |
| 4 | none of the above | original result, never worse than stock |

Step 2 is the important one: the collector keeps only an in-memory tail window, so window edges
always cut characters. Treating that edge damage as "not UTF-8" is exactly how naive fixes turn a
large block of perfectly good Chinese into garbage.

## Install

Requirements:

- DSH `0.2.0` or newer;
- a core whose `OutputCollector` exposes `snapshot()` (0.2.x desktop) or the `chunks` / `total`
  fields (early builds such as `@deepseek-ai/dsh-subprocess-local` 0.0.1-rc.1).

### From npm (recommended)

1. Sidebar **Plugins** → **Install plugin**, enter:

   ```text
   dsh-utf8-output
   ```

2. Restart DSH (host plugins load when the profile starts).

Command-line equivalent:

```powershell
dsh plugin --profile desktop add dsh-utf8-output
```

### From GitHub

```text
https://github.com/TLEWA/dsh-utf8-output
```

Pinned to a tag:

```powershell
dsh plugin --profile desktop add github:TLEWA/dsh-utf8-output#v0.1.0
```

### From source

```powershell
git clone https://github.com/TLEWA/dsh-utf8-output.git
cd dsh-utf8-output
npm test
dsh plugin --profile desktop add .
```

## Scope

- Only the **decoding** of subprocess output changes; commands, arguments, exit codes, timeouts and
  `spillPath` are untouched;
- pure UTF-8 / ASCII output is byte-identical (step 1 returns immediately);
- every caller that goes through the `subprocess` service is covered (`ops_bash`, `bash`, `pwsh`,
  …), including service references other plugins already hold (cordis hands out proxies over one
  instance, so one patch is enough);
- re-loading the plugin or calling `apply()` twice is idempotent; a wrapper that failed to install
  leaves no "already bridged" marker, so the next load retries, and `dispose` restores `spawn` and
  clears the marker only while its own wrapper is still the current `spawn`, never clobbering a
  wrapper another instance installed later.

## Known limitations

- byte sequences that are **valid UTF-8 and valid GBK at once** cannot be told apart (UTF-8 wins);
  this is very unlikely for meaningful text;
- a GBK window can start on the trail byte of the previous character and the remaining fragment can
  still be valid GBK on its own — e.g. `d0 ce c4 61 62 63` is both the tail of `中文abc` from byte
  2 and a complete `形腶bc`. The collector exposes no character-alignment information, so the plugin
  takes the directly decodable result and does not repair such head drift (no heuristic is used, to
  avoid introducing new wrong characters);
- mixed encodings (part UTF-8, part GBK) are judged as a whole, with no per-segment sniffing;
- UTF-16 / UTF-32 output is not handled: UTF-16LE text is full of NUL bytes and decodes to
  unreadable characters (never worse than stock);
- a window that starts mid-character can still show a single `U+FFFD` — same as stock behaviour,
  never worse;
- only GB18030/GBK/CP936 is implemented; Big5 (950), CP932 and CP949 are out of scope and keep the
  stock output;
- each read still decodes the whole retained window; the edge check is byte-level, decoders are
  reused and repeated identical reads hit a one-entry memo, so a 2.8KB window costs ~10µs per read,
  but a huge stream polled at high frequency remains O(n²);
- other platforms do not have this bug: `apply()` returns immediately, installs nothing and leaves the
  original buffers/strings untouched.

## Development

```powershell
npm test    # node test/run.mjs
npm run check
```

Coverage:

- `test/decode.test.mjs`: decoding decisions (UTF-8 tail cut, large UTF-8 head cut, misaligned GBK
  head, dangling GBK tail byte, oversized GBK windows, ASCII passthrough);
- `test/collector.test.mjs`: service wiring (`spawn` wrapping, `readFrom` / `finalize` re-decoding,
  idempotency, fallback to `chunks` / `total` on cores without `snapshot()`).

## Other DSH projects I work on

Fixing mojibake is only one corner of DSH. These are the other plugins I maintain — take what fits.

- **[dsh-sidebar-row-menu](https://github.com/TLEWA/dsh-sidebar-row-menu)** — right-click menus for sidebar workspace and session rows: entries join the native host menu, and a right-click in the conversation body can turn the toolbar buttons into a menu.
- **[dsh-sidebar-organizer](https://github.com/TLEWA/dsh-sidebar-organizer)** — a layout organizer for seven regions: sidebar, sidebar footer, conversation tabs, composer, session header, right panel, and settings navigation all support long-press drag to reorder, and panels can be tucked into "More".
- **[dsh-better-choice](https://github.com/TLEWA/dsh-better-choice)** — an `ask_user_question` enhancement: right-click an option to add a note, or ask the model a side question with the same context before choosing.
- **[dsh-if](https://github.com/TLEWA/dsh-if)** — the `/if` command: let the model judge a condition from prior context, then send the instruction below it as a user message only when it holds.
- **[dsh-opencode-go-router](https://github.com/TLEWA/dsh-opencode-go-router)** — rotates OpenCode Go routing after a context fold or a system-prompt rewrite, so less of the prompt cache is lost.
- **[dsh-fastload](https://github.com/TLEWA/dsh-fastload)** — trims the first history page of long sessions while preserving the tail the user actually sees.
- **[dsh-ptc-noargs](https://github.com/TLEWA/dsh-ptc-noargs)** — fixes rejected argument-less tool calls in PTC `run_code` by normalizing an omitted or `undefined` first argument to `{}`.

## License

MIT © 2026 TLEWA

## Codex PR review

This repository adopts the v1 shared review block in AGENTS.md from [central CI](https://github.com/TLEWA/dsh-plugin-ci). Cloud Codex reviews PRs and new commits; maintainers retain final approval and merging. Review results must cover the latest commit. Review consumes subscription usage; use `@codex review` for missing results.
