# AGENTS.md

本仓库是一个 DSH 插件。开工前先读仓库的 `README.md`；通用流程与检查项看中心仓的 [PROCESS.md](https://github.com/TLEWA/dsh-plugin-ci/blob/v1/PROCESS.md) 与 [docs/gates.md](https://github.com/TLEWA/dsh-plugin-ci/blob/v1/docs/gates.md)。本文件只强调本类仓库最容易出错的点。

## 插件的硬性约束

- `package.json` 必须有顶层 `engines.dsh`；写在 `dsh.engines.dsh` 会被忽略。
- `dsh.manifestVersion` 必须是 1，`dsh.bundle.patch` 必须指向真实存在的 `cordis.patch.yml`。
- `cordis.patch.yml` 里 `insert[].name` 必须等于包名；`id` 是用户可见的短名，不要随意改。
- `dsh.client.inject` 只允许 `@deepseek-ai/*`，裸模块名（如 `react`）不会被打包。
- `lib/` 是直接运行的源码（本仓库没有构建步骤）；不要新增 build 步骤，也不要把 `lib/index.js` 改成生成物。
- `package.json` 的 `scripts.prepublishOnly` 必须调用 `dsh-ci-gate --prepublish`；它拦截本机 `npm publish`，不要删除或绕过。

## 本仓库专属

`dsh-utf8-output` 不 patch DSH 内核，而是在 `lib/index.js` 里包装 `subprocess` 服务，
把子进程 `OutputCollector` 的输出重新解码。`lib/index.js` 就是源码，本仓库没有构建步骤。

- 只在 Windows 上生效；其他平台必须保持 no-op，不能改变原始 Buffer/字符串。
- 纯 UTF-8 / ASCII 字节必须原样返回；只有检测到损坏才进入宽容解码或 GB18030/GBK 回退。
- `decodeStreamText` 的顺序是契约：严格 UTF-8 → 边缘损伤宽容 UTF-8 → GB18030/GBK → 原样；
  不要让新分支抢在严格 UTF-8 前面。
- 包装必须幂等：`__utf8OutputPatched` 防重复，`apply` 多次不能重复包 collector。
- 同时覆盖 `readFrom` / `finalize`，以及新内核 `snapshot()` 与旧内核 `chunks/total` 两条读取路径。
- 不新增运行时依赖；`inject` 只声明 `subprocess`。
- `test/run.mjs` 会自己枚举 `*.test.mjs` 并 spawn 显式文件（Node 20 不展开 glob），不要改成
  `node --test test/`。`test/integration.mjs` 是手工 E2E，改真实宿主路径时必须手动跑。

## 每次改动

1. 从最新 main 开 `feat/` 或 `fix/` 分支。
2. 改代码、测试、双语文档与 CHANGELOG（同一个 PR）。
3. 本地跑 gate，全绿再 push；不要复制 gate 脚本，CI 会通过 `.ci` 运行中心仓的版本。
4. 开 PR 并按模板勾选；`ci / ci-ok` 通过后由维护者合并。改 CI、AGENTS 或 PR 模板必须加 `ci-change`；
   `human-approved` 只能由人加，模型不得自行添加。

```bash
npx --yes --package=github:TLEWA/dsh-plugin-ci#v1 dsh-ci-gate
npm test
```

## 发布

只由维护者打 tag 触发 `release.yml`。模型不得执行 `npm publish`、不得改版本号（除非在 `release/` 分支上且被明确要求）。

<!-- dsh-review-policy:v1:start -->
## Code Review Rules

- 用中文报告可证明的严重缺陷，写清触发条件、实际影响和最小相关代码位置；避免风格建议及重复 CI 已完成的机械检查。未返回审阅结果不表示通过。
- 检查宿主兼容性与用户数据边界：插件不得意外改变非目标请求、消息、配置或持久化数据；判断影响时遵守本仓明确记录的兼容例外。
- 检查异常、取消、卸载与重复初始化路径：钩子、监听器和共享状态应正确清理；失败回退不得造成重复执行、数据丢失或泄漏敏感信息。
- 审阅只发表意见。不得自动修复、添加人工批准标签、合并、改版本或发布；保留现有 CI 与人工批准流程。
<!-- dsh-review-policy:v1:end -->

### 本仓审阅重点

- 非 Windows、有效 UTF-8 和 ASCII 必须保持原样；维持严格解码优先级、包装幂等及新旧 collector 读取路径兼容。
