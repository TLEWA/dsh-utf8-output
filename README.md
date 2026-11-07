# dsh-utf8-output

[![CI](https://github.com/TLEWA/dsh-utf8-output/actions/workflows/ci.yml/badge.svg)](https://github.com/TLEWA/dsh-utf8-output/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-utf8-output.svg)](https://www.npmjs.com/package/dsh-utf8-output)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[简体中文](README.md) · [English](README.en.md)

修复 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）在 Windows 上执行命令时的中文乱码。

乱码长这样：

```text
����λ�� ��:1 �ַ�: 134
+ ... lect-Object ProcessId,CreationDate,@{n='MB';e={[math]::Round(/usr/bin ...
```

装了本插件之后，同样的命令输出正常显示：

```text
所在位置 行:1 字符: 134
+ ... lect-Object ProcessId,CreationDate,@{n='MB';e={[math]::Round($_.WorkingSetSize/1MB)}} ...
```

## 根因

DSH 的子进程服务（`@deepseek-ai/dsh-subprocess-local`）把子进程 stdout/stderr 的**原始字节**
用 `Buffer#toString("utf8")` 解码：

```js
readFrom(fromByte) {
  return { text: buffer.toString("utf8"), ... };
}
```

而 Windows 上 `cmd.exe` / `powershell.exe` 下的程序普遍按系统 **OEM 代码页**输出：

| 系统语言 | 代码页 | 编码 |
| --- | --- | --- |
| 简体中文 | 936 | GBK |
| 繁体中文 | 950 | Big5 |
| 日文 | 932 | CP932 |
| 韩文 | 949 | CP949 |

这些字节不是合法 UTF-8，`toString("utf8")` 会把每一段非法字节替换成 `U+FFFD`（`�`），
原始信息**不可逆丢失**，agent 只能看到乱码。问题不在 bash 工具、也不在命令本身。

## 修复方式

本插件**不改内核文件**，而是挂到 cordis 的 `subprocess` 服务上：

1. `apply(ctx)` 取到 `subprocess` 服务，包装它的 `spawn()`；
2. 每个 handle 的 `handle.collected.stdout` / `.stderr` 都是保留原始字节的 `OutputCollector`；
3. 替换这两个 collector 的 `readFrom()` 与 `finalize()`，从**保留的原始字节**重新解码后再交给上层。

解码顺序：

| 步骤 | 判据 | 结果 |
| --- | --- | --- |
| 1 | 严格 UTF-8（`fatal: true`）能解 | 原样返回，零改动 |
| 2 | 只有窗口首/尾被截断（≤3 字节残片），其余是干净 UTF-8 | 宽容 UTF-8（边缘保留一个 `U+FFFD`） |
| 3 | 按 GB18030 严格可解（必要时跳过 1–3 个错位字节重新对齐） | 按 GBK 解码 |
| 4 | 都不成立 | 原样返回，绝不比内核更差 |

第 2 步是关键：collector 只保留内存尾部窗口，窗口边界必然会截断字符。把这种「边缘损伤」
误判成「不是 UTF-8」，正是很多同类修法把大段正常中文也变成乱码的原因。

## 安装

要求：

- DSH `0.2.0` 或更新版本；
- 内核的 `OutputCollector` 暴露 `snapshot()`（0.2.x 桌面版）或 `chunks` / `total` 字段
  （`@deepseek-ai/dsh-subprocess-local` 0.0.1-rc.1 这类早期构建）。

### 从 npm 安装（推荐）

1. 侧边栏 **插件** → **安装插件**，输入：

   ```text
   dsh-utf8-output
   ```

2. 重启 DSH（host 插件在 profile 启动时加载）。

命令行等价写法：

```powershell
dsh plugin --profile desktop add dsh-utf8-output
```

### 从 GitHub 安装

```text
https://github.com/TLEWA/dsh-utf8-output
```

固定到标签：

```powershell
dsh plugin --profile desktop add github:TLEWA/dsh-utf8-output#v0.1.0
```

### 从源码安装

```powershell
git clone https://github.com/TLEWA/dsh-utf8-output.git
cd dsh-utf8-output
npm test
dsh plugin --profile desktop add .
```

## 生效范围

- 只改子进程输出的**解码**，不动命令、参数、退出码、超时和 `spillPath`；
- 纯 UTF-8 / ASCII 输出逐字节不变（第 1 步直接返回）；
- 覆盖所有走 `subprocess` 服务的调用（`ops_bash`、`bash`、`pwsh` 等），
  包括其他插件早先拿到的服务引用（cordis 对同一实例返回代理，补丁一次全生效）；
- 插件重复加载、重复 `apply()` 都是幂等的。

## 已知限制

- **GBK 恰好是合法 UTF-8** 的字节序列无法区分（会按 UTF-8 解），这类短串概率极低；
- 混合编码（一段 UTF-8 一段 GBK）只按整体判断，不做分段嗅探；
- UTF-16 / UTF-32 输出不处理；
- 窗口首字符被截断时仍可能出现 1 个 `U+FFFD`——与内核原本的行为一致，不新增损伤；
- 每次读取会重解码整个保留窗口，超大输出被高频轮询时是 O(n²)；`ops_bash` 单次读取不受影响；
- 非 Windows 平台没有这个乱码问题，插件对它们是无操作（但仍会执行第 1 步判定）。

## 开发与测试

```powershell
npm test    # node test/run.mjs
npm run check
```

测试覆盖：

- `test/decode.test.mjs`：解码判定（UTF-8 尾部截断、UTF-8 头部大段截断、GBK 头部错位、
  GBK 尾部落单字节、超大 GBK 窗口、ASCII 原样）；
- `test/collector.test.mjs`：服务接线（`spawn` 包装、`readFrom` / `finalize` 重解码、
  幂等性、没有 `snapshot()` 的旧内核回退到 `chunks` / `total`）。

## 许可证

MIT © 2026 TLEWA
