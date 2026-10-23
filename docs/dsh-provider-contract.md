# DSH Provider 契约（ZCode 副本）

本文件是 `dsh-zcode-provider` 对 DSH 宿主契约的现场记录：宿主需要什么、本插件承诺什么、哪些是实测过的、哪些仍是待续订后补测的已知限制。内容按本仓代码逐条对账，不引用其他 provider 仓的文档（避免外部漂移）。

## 验证基线

- 契约来源：DSH 官方文档 `docs/user/develop/practice/llm-adapter.zh.md`，2026-10-24 读取副本（源 revision `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`）。
- 参考实现：DSH 官方 `packages/llm/llm-deepseek/`。
- 本仓实测环境：Node v24.15.0（`D:\nodejs\node.exe`）、ZCode 0.17.0（`F:\AgentData\zcode\cli\resources\glm\zcode.cjs`）。
- 证据边界：**结构级已核，功能级未验证**。ZCode 账号当前返回 provider code `1309`（套餐到期），所以「一次真实成功调用」的 stdout 形状、sessionId 获取、`--mode guarded` 非交互行为、150% 计费验证四项都没有读数，见文末「已知限制」。

## 插件入口

插件是 Cordis 模块，导出（`src/index.ts`）：

```ts
export const name = 'dsh-zcode-provider'
export const inject = ['llm', 'sessions', 'workspaceRegistry', 'sandboxPolicy', 'permissionPresets', 'approval']
export const Config = BundleConfig            // bundle 默认 enabled: true
export const ZCODE_PROVIDER_ROUTE = 'zcode'
export const ZCODE_SETTINGS_NS = 'dsh-zcode-provider'
export const ZCODE_DISPLAY_NAME = 'ZCode'
export async function apply(ctx: Context, config: Config): Promise<void>
```

`apply()` 无条件先注册设置面板条目：

```ts
ctx.llm.registerConfigurableProviders([{
  provider: 'zcode',
  displayName: 'ZCode',
  settingsNs: 'dsh-zcode-provider',
  settingsPath: [],
}])
```

注册失败（同一 profile 挂载两次）只记 `warn`，路由仍可用。`config.enabled !== true` 时不注册 adapter。

**不注册 `registerModelDiscovery`**：ZCode 0.17.0 没有零额度的模型列举接口，发现动作必然花掉一次真实请求，因此模型目录是静态的（见「模型目录」）。

adapter 模块用变量化 specifier 懒加载（`const ADAPTER_MODULE_SPECIFIER = './provider/zcode.js'`）。加载失败或未导出 `ZcodeAdapter` 时 **只 `logger.error`，不抛**：`apply()` 在宿主启动期运行，一个加载不了的 adapter 不能把整个 profile 拖下去。这是有意行为，测试按「不崩宿主」断言。

## Adapter 接口

实现类继承 `LlmAdapter`，必须实现 `stream()`：

```ts
class ZcodeAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {}
}
```

可选覆写五个方法中的其余四个：

| 方法 | 本插件的承诺 |
|---|---|
| `providerInfo(provider)` | 返回 `ZCode` 展示名与静态目录 |
| `listModels(provider)` | 返回 `DEFAULT_MODELS`（`GLM-5.3-Flash`、`GLM-5.3`），按 `visibleModels` 过滤 |
| `resolveModel(provider, model, signal?)` | 只解析静态目录内的 id；目录外 id 显式报错，不改写、不猜测 |
| `providerRetryPolicy(provider)` | 可重试码 = `RATE_LIMIT`、`TIMEOUT`、`ZCODE_EXIT`、`ZCODE_UNKNOWN` |

## Request

`GenerateOptions` 是 DSH 已组装的无提供方请求：`provider`、`model`、`messages`、`system`、`tools`、`temperature`、`maxTokens`、`stop`、`reasoningEffort`、`signal`、`sessionId`、`purpose`。

- `signal` 必须尊重：取消即终止子进程，映射为 `ABORTED`。
- 不支持的字段不能静默丢弃，必须抛带稳定 code 的 `ZcodeError`。当前 `toolPolicy: reject`（默认）下非空 `tools`、image block、`temperature`、`maxTokens`、`stop` 都在启动进程前拒绝（`UNSUPPORTED_TOOLS`）。
- ZCode 的单次 `-p` 协议没有 reasoning effort 通道，`reasoningEffort` 不做映射，也不假装支持。

## StreamChunk 顺序

最小文本流顺序是硬约束，`finish` 必须是最后一个分片，`usage` 必须在 `finish` 之前：

```text
block-start(text)
text-delta*
block-end(text)
usage?
finish(stop | length | error)
```

- 一个文本块内可以有任意多个 `text-delta`，但不得在 `block-end` 之后继续追加同块增量。
- `usage` 只在拿到真实计数时发出；`totalTokens` 缺失时宁可不发，也不填 0 冒充。
- 工具分片（`tool-call-delta`）在本插件里**不产出**：ZCode 的工具由它自己执行，`--mode guarded` 拒绝交互式提问，适配器不会把内部行为伪装成 DSH tool call。

## Package / Bundle

可安装插件是 npm bundle，不是裸源码：

```json
{
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib/**/*.js", "lib/**/*.d.ts", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` 通过包名插入插件行；运行时零依赖（`dependencies: {}`），`@deepseek-ai/*` 全部走 `peerDependencies`。

## 环境契约（fail-closed）

ZCode 0.17.0 需要五项环境变量，缺任一项会在启动 714 ms 内以一条与根因相距很远的消息退出。插件不做推导、不设默认值，**在 spawn 之前**检查（`assertEnvContract()`）：

| 变量 | 本机取值（2026-10-24 实测） | 缺失后果 |
|---|---|---|
| `ZCODE_HOME` | `F:\AgentData\zcode\data\.zcode` | 无法创建 store manager，启动期退出 |
| `ZCODE_DATA_BASE_DIR` | `F:\AgentData\zcode\data` | 同一 bootstrap 步骤失败 |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | `F:\AgentData\zcode\cli\resources\config\provider\zcode-builtin.json` | 714 ms 内报「无法定位 CLI ZCode Built-in Provider Config」 |
| `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` | `F:\AgentData\zcode\data\.zcode\v2\provider_config.json` | 只给内置/个人之一，ZCode 以「必须同时提供」拒绝两者 |
| `NODE_OPTIONS` | `--no-network-family-autoselection --dns-result-order=ipv4first` | 双栈主机上 HTTP 客户端报空的 `AggregateError`，只显示 `Cannot connect to API:` |

缺项时抛 `ZcodeError('ZCODE_ENV_MISSING')`，消息逐项列出「变量名（expected 值）」，`stderrTail` 记 `missing: A, B`。取值刻意写死成本机读数，是为了让另一台机器能和它 diff，而不是靠猜 ZCode 堆栈。

写入环境变量用 `scripts/install-env.ps1`（默认 dry-run，`-Apply` 才写用户级变量；`NODE_OPTIONS` 已存在时追加去重，不覆盖用户其他选项）。写完后**必须重启 DSH**：插件在 spawn 时读取环境，进程内的 `process.env` 不会自己刷新。

## argv 契约

`buildZcodeArgs()` 是纯函数，恒定产出：

```text
-p <prompt> --mode guarded --json --cwd <cwd> [--resume <sessionId>] [--verbose]
```

- `--mode` 的取值只有 `guarded`，由常量固定；任何其他取值（包括配置里写别的）在函数入口抛 `TypeError`，不是警告、不是回退。
- `--resume` 只在 `resume === true` **且** `sessionId` 非空、且不以 `-` 开头时出现，避免把用户内容拼成 flag。
- `--verbose` 恒在最后，不影响前面几项的位置。

## 错误码表

`ZCODE_ERROR_CODES` 共 12 个，冻结于 B2，不新增第 13 个；错误只从 stderr 文本解析（`classifyStderr()`），provider 数字码保留在 `ZcodeError.providerCode`。

| code | 含义 | 可重试 |
|---|---|---|
| `QUOTA` | 额度/套餐拒绝（本机 1309） | 否 —— 不会自愈 |
| `RATE_LIMIT` | 速率限制（含 429） | 是 |
| `PERMISSION_REQUIRED` | 账号无权执行该请求 | 否 |
| `AUTH` | 身份被拒 | 否 —— 需要新凭据 |
| `ZCODE_ENV_MISSING` | 环境契约不完整 | 否 —— 需先修宿主 |
| `MODEL_NOT_FOUND` | ZCode 不认识请求的模型 | 否 |
| `ZCODE_PARSE` | stdout/帧解析失败 | 否 |
| `ZCODE_EXIT` | 非零退出 | 是 |
| `ZCODE_UNKNOWN` | 未识别的失败 | 是 |
| `TIMEOUT` | 墙钟或空闲超时 | 是 |
| `ABORTED` | 调用方取消 | 否 |
| `UNSUPPORTED_TOOLS` | 请求携带了本模式不支持的能力 | 否 |

`stderrTail` 一律截断到 2048 字符（`STDERR_TAIL_MAX_CHARS`），报告里只出现有界片段。

## 模型目录

静态双模型（design D2），实测自 ZCode 0.17.0 的 configured providers：

- `GLM-5.3-Flash` —— 默认（`DEFAULT_MODEL`）
- `GLM-5.3`

任何第三个 id 在 `resolveModel`/`stream` 入口显式报错（不静默替换成默认模型，也不猜测后缀）。`provider_config.json` 的 `defaultModelSelection` 若在 ZCode 客户端里被改动，静态目录需要人工同步 —— 这是 doctor 的 `model-catalog` 检查项存在的原因。

## 会话

- `sessionMode: full`（默认）：每轮把 DSH 完整历史发给一次新的 `-p` 调用。重启安全，且是当前唯一可验证的模式（sessionId 获取未实测）。
- `sessionMode: resume`：需要有可复用的 session id；拿不到 id 时该模式不可用，见已知限制。插件不伪造 id：映射只存在进程内，插件重启即用完整历史新建。

## 诊断

`src/diagnostics.ts` 只做只读探测（Node 版本、环境契约、CLI 入口存在性、内置/个人 provider 配置可读性与 JSON 解析、模型目录、最近一次 quota 拒绝的记录），不 spawn 进程、不写文件、不改 ZCode store。

`runDoctor()` 把探测聚合成 8 个固定检查项：

| id | 判据 |
|---|---|
| `node-version` | 主版本 < 22 → fail（ZCode 0.17.0 加载 `node:sqlite`） |
| `node-executable` | `config.nodePath` 不存在或不是文件 → fail |
| `env-contract` | 五项缺任一 → fail；取值与记录不一致 → warn |
| `cli-entry` | `config.zcodeCjsPath` 不存在或不是文件 → fail |
| `builtin-config` | 不存在 / 不可读 / 非 JSON 对象 → fail |
| `personal-config` | 同上（ZCode 要求两者同时提供） |
| `model-catalog` | 目录为空或默认模型不在目录内 → fail；出现静态目录外的 id → warn |
| `last-quota` | 仅报告「本进程最近一次看到的 provider code」，永不 fail |

报告固定带 `quotaUsed: false`，**不含任何套餐/权益判定字段**：插件无法查询账号状态，只能记录「上一次调用遇到 1309」。报告里的路径与环境变量值只用于让操作者定位问题，未包含提示词、响应正文、凭据或会话内容。

所有探测输入（env、路径、Node 版本、文件读取器、上次 quota 记录、时钟）都可注入，因此 `tests/doctor.test.mjs` 对假宿主判定，不读本机真实 ZCode 配置。

## 安装与回退

**安装（三步，均不重启 DSH 之外的自动化）：**

1. 环境变量：`pwsh -File scripts/install-env.ps1` 先看 dry-run 输出（将设置的键、旧值、新值、路径存在性警告），确认后 `pwsh -File scripts/install-env.ps1 -Apply`。
2. 插件行：在 `C:\Users\toast\.dsh\profiles\desktop\package.json` 的 `dependencies` 加本包，在 `cordis.patch.yml` 加插件条目。**改前先备份这两个文件**（连同日期），改动只增不删，不动既有 `subagent-acp-*` 与 `tool-subagent*` 条目。
3. 重启 DSH（环境变量与插件装载都只在启动时读一次）。

**回退：**

1. 从 `cordis.patch.yml` 删除本插件条目，再从 `package.json` 的 `dependencies` 移除本包（或恢复备份）。
2. 环境变量可保留：它们只是 ZCode CLI 需要的宿主配置，删掉会让 ZCode 本体也起不来；确需删除时按 `install-env.ps1` 输出的键名逐个 `[Environment]::SetEnvironmentVariable(name, $null, 'User')`。
3. 重启 DSH。

## 已知限制

- **L1 未验证成功路径**：账号 1309，`-p` 成功时的 stdout 形状（NDJSON 还是整段 JSON）没有读数，因此 `parseStdout()` 的口径是结构推定，不是实测。
- **L2 未验证 sessionId**：拿不到 `sess_…` 的稳定来源，`sessionMode: resume` 因此不可用，默认 `full`。
- **L3 未验证 `--mode guarded` 非交互行为**：要求写文件的 prompt 在守护模式下的表现（挂起 / 排队 / 被拒）未观测。
- **L4 未验证 150% 计费**：产品目标要求的倍率没有服务端账单读数，**禁止用本地文件推断计费**。
- **L5 不判权益**：doctor 与运行时都不判断套餐状态，1309 只作为历史观测记录。
- **L6 错误码语义待校准**：`3007` / `3012` 的真实语义（风控还是权限）未核对，映射可能需微调。
