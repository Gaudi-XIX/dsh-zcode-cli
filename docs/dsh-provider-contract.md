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

注册失败（同一 profile 挂载两次）只记 `warn`，路由仍可用。`config.enabled` 为假时不注册 adapter。

`enabled` 在 schema 里带 `.volatile()`（改设置立即生效），因此宿主交给 `apply()` 的常常不是布尔值，而是 `{ isVolatile, get() }` 引用。判定统一走 `configBoolean()`：原生布尔与可调用 `get()` 的引用都接受，其他形状按 `false` 处理；`enabled === true` 这种直接比较对引用恒假，会让 adapter 永不注册（`tests/register.test.mjs` 的 A1 用例守住这条）。

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
| `listModels(provider)` | 配置目录（`config.models`，缺失时用 `DEFAULT_MODELS`，并**并入** `config.model`）按 `visibleModels` 过滤 |
| `resolveModel(provider, model, signal?)` | 只解析静态目录内的 id；目录外 id 显式报错，不改写、不猜测 |
| `providerRetryPolicy(provider)` | 可重试码 = `RATE_LIMIT`、`TIMEOUT`、`ZCODE_EXIT`、`ZCODE_UNKNOWN` |

## Request

`GenerateOptions` 是 DSH 已组装的无提供方请求：`provider`、`model`、`messages`、`system`、`tools`、`temperature`、`maxTokens`、`stop`、`reasoningEffort`、`signal`、`sessionId`、`purpose`。

- `signal` 必须尊重：取消即终止子进程，映射为 `ABORTED`。
- 不支持的字段不能静默丢弃，必须抛带稳定 code 的 `ZcodeError`。默认 `toolPolicy: dsh-owned` 下工具 schema 照常下发并投影回 DSH；`reject` 下非空 `tools` 报 `UNSUPPORTED_TOOLS`，image/file block 报 `UNSUPPORTED_CONTENT`——两条在 spawn 之前生效（`channel: cli`）或在开 socket 之前生效（`channel: free|paid`）。`temperature` / `maxTokens` / 非空 `stop` **只在 `channel: cli`** 报 `UNSUPPORTED_OPTION`：CLI 的 `-p` 协议没有这三个字段的入口；两个 HTTP 通道把它们原样放进请求体（见「传输通道」）。
- `toolPolicy: dsh-owned`（默认）把 DSH 的工具 schema 下发，端点回的 `tool_use` 投影成 `block-start(tool-call) → tool-call-delta* → block-end(tool-call)` 并以 `finish{tool-calls}` 收尾；`zcode-owned` 丢弃 schema 后继续，但端点若仍回 `tool_use` 则 fail-closed；`reject` 直接拒绝带 tools 的回合。两种宽松策略下 image/file 投影为占位文本（`[图片附件 … 图片内容未发送]`），不静默丢失。
- `reasoningEffort` 不映射到 CLI（`-p` 协议没有该通道）；HTTP 通道把它放进 `output_config.effort`，取值 `low|medium|high|max`，缺省 `high`。

## 传输通道（channel）

`config.channel` 三选一，缺省 `cli`；浏览器端卡片选择在下一次请求生效（`resolveTurnChannel()`），无法识别的值回落到注册时捕获的 `channel`，**不猜传输方式**——猜错会花掉一个用户没选的凭据。

| 通道 | 传输 | 凭据来源 | 端点 |
|---|---|---|---|
| `cli` | spawn `zcode.cjs -p … --mode guarded --json` | 由 CLI 自己管 | 本机进程 |
| `free` | HTTP，Anthropic Messages 形状的流式 SSE | ZCode CLI 登录态：`<ZCODE_DATA_BASE_DIR>/.zcode/v2/credentials.json` 的 `zcodejwttoken`（`enc:v1:` AES-256-GCM，12 字节 IV + 16 字节 tag，密钥 = `sha256(ZCODE_CREDENTIAL_SECRET)`，变量缺省时用本机回落串）+ `telemetry-state.json` 的 `deviceMid`（`x-device-mid`） | `https://zcode.z.ai/api/v1/zcode-plan/anthropic` + `/v1/messages` |
| `paid` | 同上 | 只从环境读 `ZCODE_PAID_API_KEY`；**不读配置文件**，`config.apiKey` 不接受 | `config.paidBaseUrl`（缺省 `https://open.bigmodel.cn/api/anthropic`）+ `/v1/messages` |

请求体的字段是本机抓包（`F:\AgentData\.agents\flow\tmp\zc-capture.json`，123 KB，一次真实 free 通道请求的完整请求体与 SSE 响应）逐字段对出来的：`model`、`max_tokens`（缺省 `128000`）、`system`（prefix 块 + 调用方 system）、`messages`（`user`/`assistant` 两角色，system/工具等非对话轮折进 `user` 并在正文前加角色标题）、`thinking: {type: 'enabled'}`、`output_config.effort`、`stream: true`；`temperature` 与 `stop_sequences` 只在调用方设置时才出现。`free` 通道额外带 `metadata.user_id`（`device_id` = `deviceMid`、`session_id` = 会话 id），`paid` 通道不带——它没有设备与会话绑定，发一个空 `device_id` 等于声明一件本适配器无法背书的事。

失败映射：非 2xx 按状态码与响应体分派到 `ZCODE_HTTP` 一族（`ZCODE_CREDENTIAL_*`、`ZCODE_BILLING_*` 由各自的模块产出），SSE 里的 tool 停止原因按 `toolPolicy` 判 `UNSUPPORTED_TOOLS`；HTTP 通道的默认墙钟上限 `900000` ms（`ZCODE_HTTP_DEFAULT_TIMEOUT_MS`），失败诊断里回显的响应体截到 `512` 字符（`ZCODE_HTTP_BODY_SNIPPET_MAX_CHARS`）。

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

ZCode 0.17.0 需要四项**宿主提供**的路径变量，外加一项 **provider 在 spawn 时自己注入**的 `NODE_OPTIONS`。插件不做推导、不设默认值，在 spawn 之前检查（`assertEnvContract()`）：

| 变量 | 提供方 | 期望取值（变量当前未设置；四个路径本机实测存在） | 缺失后果 |
|---|---|---|---|
| `ZCODE_HOME` | 宿主 | `F:\AgentData\zcode\data\.zcode` | 无法创建 store manager，启动期退出 |
| `ZCODE_DATA_BASE_DIR` | 宿主 | `F:\AgentData\zcode\data` | 同一 bootstrap 步骤失败 |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 宿主 | `F:\AgentData\zcode\cli\resources\config\provider\zcode-builtin.json` | 714 ms 内报「无法定位 CLI ZCode Built-in Provider Config」 |
| `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` | 宿主 | `F:\AgentData\zcode\data\.zcode\v2\provider_config.json` | 只给内置/个人之一，ZCode 以「必须同时提供」拒绝两者 |
| `NODE_OPTIONS` | provider | `--no-network-family-autoselection --dns-result-order=ipv4first` | 不会缺失：子进程环境里恒有这两个 flag；用于避免双栈主机上 HTTP 客户端报空的 `AggregateError` |

路径项缺任一 → `ZcodeError('ZCODE_ENV_MISSING')`，消息逐项列出「变量名（expected 值）」，`stderrTail` 记 `missing: A, B`。取值刻意写死成本机读数，是为了让另一台机器能和它 diff，而不是靠猜 ZCode 堆栈。

`NODE_OPTIONS` 走**值级白名单**（`resolveNodeOptions()`）：宿主若设置了它，token 只允许上面两个 flag，其他任何 token（`--require`、`-r`、`--import`、`--loader`、`--inspect`、`-e` 等）都在 spawn 前报 `ZCODE_ENV_MISSING`——`NODE_OPTIONS` 会进入子进程，等于一条代码执行通道，不能透传。

**子进程环境是闭集**（`buildChildEnv()`）：只取 `PATH`、`SystemRoot`、`SystemDrive`、`windir`、`TEMP`、`TMP`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`COMSPEC`、`PATHEXT`，加上上面五项契约值与 `config.passEnv` 显式列出的变量名。宿主其他变量（含各种 API key / token）不会进入子进程；测试用 `SECRET_CANARY` 断言这一点。

写入路径变量用 `scripts/install-env.ps1`（默认 dry-run，`-Apply` 才写用户级变量）。`-Apply` 遇到「已存在且与目标值不同」的变量会 **WARNING 并跳过**，只有再加 `-Force` 才覆盖——避免脚本一跑就把用户自己的 `NODE_OPTIONS` 冲掉；`NODE_OPTIONS` 例外：脚本给出的候选值本身就是「现有值 + 缺失的 DNS flag」，`-Force` 写下去的是这个合并值，用户其他 flag 仍在。`NODE_OPTIONS` 也不必再写用户级变量：provider 在 spawn 时注入。写完仍需**重启 DSH**（宿主环境在启动时读一次）。

## argv 契约

`buildZcodeArgs()` 是纯函数，恒定产出：

```text
-p <prompt> --mode guarded --json --cwd <cwd> [--resume <sessionId>] [--verbose]
```

- `--mode` 的取值只有 `guarded`，由常量固定；任何其他取值（包括配置里写别的）在函数入口抛 `TypeError`，不是警告、不是回退。
- `--cwd` 取自**本会话的 workspace 根**：`ctx.sessions.get(sessionId).header.cwd` → `workspaceRegistry.resolveByPath()` → `status() === 'ok'` → `workspace.path`。解析不到（无 session、无 resolver、目录已删、status 非 ok）时在 spawn 前报 `WORKSPACE_UNAVAILABLE`，**不退回** `process.cwd()`：让子进程在 DSH 安装目录里跑等于让它到处写文件。
- `--resume` 只在 `resume === true` **且** `sessionId` 非空、且不以 `-` 开头时出现，避免把用户内容拼成 flag。
- `--verbose` 恒在最后，不影响前面几项的位置。

## 错误码表

`ZCODE_ERROR_CODES` 共 **25** 个（原 17 个 + 额度面板 7 个 + HTTP 直连 1 个 `ZCODE_HTTP`：`ZCODE_CREDENTIAL_MISSING`、`ZCODE_CREDENTIAL_INVALID`、`ZCODE_CREDENTIAL_DECRYPT_FAILED`、`ZCODE_BILLING_UNAUTHORIZED`、`ZCODE_BILLING_BAD_REQUEST`、`ZCODE_BILLING_HTTP`、`ZCODE_BILLING_PARSE`）；stderr 那一半错误只从 stderr 文本解析（`classifyStderr()`），provider 数字码保留在 `ZcodeError.providerCode`；额度那 7 个只由 `src/zcode/billing.ts` 的产生，不经过 stderr。

| code | 含义 | 可重试 |
|---|---|---|
| `QUOTA` | 额度/套餐拒绝（本机 1309） | 否 —— 不会自愈 |
| `RATE_LIMIT` | 速率限制（含 429） | 是 |
| `PERMISSION_REQUIRED` | 账号无权执行该请求 | 否 |
| `AUTH` | 身份被拒 | 否 —— 需要新凭据 |
| `ZCODE_ENV_MISSING` | 环境契约不完整 / `NODE_OPTIONS` 含禁用 flag | 否 —— 需先修宿主 |
| `MODEL_NOT_FOUND` | ZCode 不认识请求的模型 | 否 |
| `ZCODE_PARSE` | stdout/帧解析失败 | 否 |
| `ZCODE_EXIT` | 非零退出 | 是 |
| `ZCODE_UNKNOWN` | 未识别的失败 | 是 || `TIMEOUT` | 墙钟或空闲超时 | 是 |
| `ABORTED` | 调用方取消 | 否 |
| `UNSUPPORTED_TOOLS` | 请求携带了本模式不接受的 tools | 否 |
| `UNSUPPORTED_OPTION` | 请求携带 `temperature` / `maxTokens` / 非空 `stop` | 否 |
| `UNSUPPORTED_CONTENT` | `reject` 模式下携带 image/file block | 否 |
| `ZCODE_BUSY` | 并发队列已满（`maxQueue`） | 否 —— 拥塞不是进程故障，不重试也不丢 session |
| `ZCODE_OUTPUT_TOO_LARGE` | 单行或总量超过 `maxEventLineLength` / `maxOutputBytes` | 否 —— 重试只会再超限 |
| `WORKSPACE_UNAVAILABLE` | 解析不到会话 workspace 根 | 否 —— 需宿主侧修数据 |
| `ZCODE_CREDENTIAL_MISSING` | `ZCODE_DATA_BASE_DIR` 下没有 `.zcode/v2/credentials.json`（或 `telemetry-state.json` 里没有 `deviceMid`） | 否 —— 先用 ZCode CLI 登录 |
| `ZCODE_CREDENTIAL_INVALID` | 凭据文件 / telemetry 状态不是合法 JSON，或 `zcodejwttoken` 字段缺失、不是字符串 | 否 —— 文件损坏，重新登录 |
| `ZCODE_CREDENTIAL_DECRYPT_FAILED` | `enc:v1:` 载荷解不开：GCM 校验失败、base64url 形状不对、密钥与登录时不一致 | 否 —— 检查 `ZCODE_CREDENTIAL_SECRET` / 是否换了 OS 账号 |
| `ZCODE_BILLING_UNAUTHORIZED` | 计费接口返回 401 / 403 | 否 —— 凭据过期或被拒，重新登录 |
| `ZCODE_BILLING_BAD_REQUEST` | 计费接口返回 400，或 HTTP 200 但业务码 `3001`（缺 `X-Device-Mid`） | 否 —— 设备标识缺失或不被接受 |
| `ZCODE_BILLING_HTTP` | 其他非 2xx（429 / 5xx 等），以及业务码非 0、非 3001 | 是 —— 服务端或网络临时状态 |
| `ZCODE_BILLING_PARSE` | 响应不是 JSON，或 `data.plans` / `data.balances` 不是数组 | 否 —— 契约变了，先看服务端 |

`ZCODE_BUSY` 与 `ZCODE_OUTPUT_TOO_LARGE` 刻意**不在**重试白名单、也**不在** `DROPS_SESSION_ON`：前者是排队拥塞，重试只会放大；后者说明输出契约被违反，换一次 spawn 也还是超限。两者也不丢 session id——session 没坏，坏的是这一次调用的形态。

`DROPS_SESSION_ON` 现只含 `ZCODE_EXIT` 与 `ZCODE_UNKNOWN`，且两者都由进程层的 `processFailure` 产出：子进程真的死了、或失败形态无法识别，服务端那一侧的状态无从判断，留着旧 id 只会让下一轮带着一个可能已失效的 id 再花一次调用。

`ZCODE_PARSE` **不在**该集合内。它只由「进程干净退出但 stdout 没有任何可识别文本帧」的空答分支产生，而进程层从不抛它，所以 `processFailure` 永远观察不到这个码；更关键的是干净退出说明服务端会话是好的，缺口在这侧解析器——而这个解析器至今没捕获过一次真实成功的 stdout（finding F-1）。在这里忘记 id，等于在证据最薄弱的地方销毁一个没人证明坏掉的会话。

`stderrTail` 一律截断到 2048 字符（`STDERR_TAIL_MAX_CHARS`），报告里只出现有界片段。诊断文本（`message` / `providerMessage`）另经 `sanitizeSecrets()` 脱敏（`Bearer …`、`?token=…`/`&sig=…` 查询参数、`sk-…` 形态的 key）并截断到 4 KiB（`DIAGNOSTIC_MAX_CHARS`）。

`providerCode` 的类型是**数字**（`ZcodeError.providerCode?: number`）：`[1309]` 解析为 `1309`，不是字符串 `'1309'`；没有数字码时字段缺席（`undefined`），调用方按 `=== 1309` 比较。

`responseStatus` 的来源是三种 stderr 形状（`HTTP_STATUS` 正则），都只接受**三位数字 + 右词边界**，再经 `100..599` 范围校验：

| 形状 | 例子 |
|---|---|
| `HTTP <n>` | `HTTP 429` |
| `status` / `status code`，分隔符 `:` 或 `=` | `status: 429`、`status code 429` |
| `responseStatus`，分隔符 `:` 或 `=`，可带空格 | `responseStatus: 429`、`responseStatus=429` |

`responseStatus` 前的 `\b` 由 `HTTP` / `status` 自身承担，不能放在 `status` 之前——真实 stderr 里是 `responseStatus: 429`，`Status` 前一个字符是单词字符 `e`，放在前面就永远匹配不到。`providerCode: 1309`、`request-id` 里的长数字串**不得**被当成状态码（负向断言见 `tests/error-codes.test.mjs`）。判定顺序不变：`providerCode 1309` 命中 `QUOTA` 在前，因此「1309 + 429」报 `QUOTA` 而不是 `RATE_LIMIT`。

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
| `env-contract` | 四项宿主路径变量缺任一 → fail；`NODE_OPTIONS` 由 provider 注入，不入判据（宿主设置时只校验值级白名单） |
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

## 额度 / 套餐面板（billing）

设置页卡片上方的「额度」「套餐」两块由插件自己的 loopback 路由供数，浏览器半边**看不到** token：解密与请求都在 Node 半边完成，卡片只拿已经归一化的 JSON。这条路径只读，不改任何 ZCode 状态。

- 路由：`GET /plugins/zcode-provider/billing`（`BILLING_ROUTE_PATH`，`src/web/router.ts`）。`src/index.ts` 在 `enabled` 判断**之前**用 `try/catch` 调 `setupBillingRoutes(ctx)`：宿主没有 `webServer` 服务时回调不会执行，挂载失败只损失面板，不影响 provider 行注册与插件加载。
- 响应：`{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`，一律 `Content-Type: application/json`、`Cache-Control: no-store`。只接受 `GET`，非 `GET` 回 405、非 loopback 对端回 403（与 agy 同类路由同口径）。
- 缓存：进程内 30 秒（`ZCODE_BILLING_CACHE_TTL_MS`），只缓存成功结果；缓存键是「上一次成功读取」。`?refresh=1` 跳过缓存并替换缓存内容。并发请求共享同一次在飞的读取（single-flight），失败不写缓存。
- 取数：`fetchBillingSnapshot(env, { fetch, now })`（`src/zcode/billing.ts`）→ `GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance`，头 `Authorization: Bearer <jwt>`、`X-Device-Mid: <deviceMid>`、`Accept: application/json`、`User-Agent: ZCode/3.4.0`。
- 凭据：`<ZCODE_DATA_BASE_DIR>/.zcode/v2/credentials.json` 的 `zcodejwttoken` 形如 `enc:v1:<iv>.<tag>.<ciphertext>`（base64url 无 padding，16 字节 IV、16 字节 GCM tag），AES-256-GCM、AAD 为空。密钥 = `sha256(secret)`，`secret = ZCODE_CREDENTIAL_SECRET`，否则 `zcode-credential-fallback:${process.platform}:${os.homedir()}:${USERNAME}`。`deviceMid` 取同目录 `telemetry-state.json`。jwt、密文与解密中间值**不进**错误 message、不进日志；错误 message 在拼好后再经 `sanitizeSecrets()`。
- 数据形状：`ZcodeBillingSnapshot { fetchedAt, plans[], balances[] }`。`plans[]` 带 `planId/name/status/startsAt/endsAt/entitlements[]`（`showName/grantUnits/capabilities/unitType/period`），`balances[]` 带 `showName/totalUnits/usedUnits/remainingUnits/availableUnits/expiresAt/capabilities`。时间在 Node 半边保持 epoch 秒，卡片用 `Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai' })` 显示为 `YYYY-MM-DD HH:mm`。字段缺失一律记为 `null`，**不编造数值**；`plans` / `balances` 不是数组直接 `ZCODE_BILLING_PARSE`。
- 卡片：`client/index.ts` 的 `useBilling()` 在 `useEffect` 里发相对路径 `fetch(BILLING_PATH)`（重试加 `?refresh=1`），带 `AbortController`，卸载时 `abort()`；加载中「读取中…」，失败显示错误码 + 一句话原因 + 「重新读取」按钮。文案全部来自 `client/locales.ts`（zh-CN / en-US 两本字典键集相同）。
- 测试：`tests/billing.test.mjs` 20 例，现场用固定密钥 + 固定 IV 加密一段测试 token（不读真实凭据文件），mock 掉全部 `fetch`；覆盖解密往返、错误密钥、7 个载荷形状错误、6 个 HTTP/业务码分支、缓存命中/过期、`?refresh=1`、路由 405/403/成功/失败与 `setupBillingRoutes` 的挂载/卸载。

## 浏览器端卡片（client half）

宿主给「设置 → 模型」里每个 provider 行渲染槽 `settings.models.provider-card`，槽位**没有回退表单**：找不到与 `entryKey` 匹配的卡片时行体就是空的。所以本包必须带一个浏览器半边，否则后端再正常，设置页里 ZCode 那一行也是空白。

- 入口：`client/index.ts`（源码）→ `scripts/build-client.mjs`（TypeScript 编译器 API 打包）→ `dist/client.js`（单文件 ESM，`dist/` 被 gitignore，门禁构建它）。`package.json` 声明 `dsh.client = { inject: ['@deepseek-ai/dsh-client-ui-primitives'], platform: 'web' }` 与 `exports['./client']`。
- 槽键：`ctx.slots.register({ name: 'settings.models.provider-card', key: 'dsh-zcode-provider', id: 'zcode-provider-card' }, …)`。`key` 必须**逐字等于** Node 半边的 `ZCODE_SETTINGS_NS`（`src/index.ts`），宿主按这个字符串匹配，写错一个字符就回到空白行。
- 槽位 props 只有 `{ provider, configured, keyConfigured }`，**不含配置本体**（配置在同一个槽的兄弟表单里）。卡片上半部分是额度/套餐两块（数据来自上面那条 loopback 路由），下半部分是**只读信息面板**，显示随包发布的默认值（模型目录、`sessionMode` / `toolPolicy` / `mode` / `imageInput`、CLI 入口、环境契约、1309 说明），不是用户当前编辑中的值；面板里明确写了「以编辑表单为准」。除额度路由外，卡片不读写宿主配置。
- Hook 纪律：`useState` / `useEffect` 只在组件上方的 `useTranslation()` 与 `useBilling()` 里，组件函数体**只有两句 hook（都在首行区）、只有一个 return**。宿主用 `SlotErrorBoundary` 包住槽内容，渲染期抛异常会渲染成空元素——hook 在条件 return 之后导致 hook 数变化时，症状与本次修的空白行一模一样。`tests/client.test.mjs` 把这条结构钉住。
- 漂移防线：卡片不能 import `src/provider/config.ts`（会拖入 schemastery 与适配器模块图，浏览器侧无法解析），所以模型目录、默认值与环境契约是**手抄字面量**；`tests/client.test.mjs` 逐项与 `src/` 和 `cordis.patch.yml` 比对，任一侧改了没同步就判红。

## 门禁

`node scripts/run-tests.mjs` 是唯一入口，顺序固定：AC11（`client/`、`src/`、`tests/`、`scripts/`、`docs/` 与根级文本文件全部 LF、无 BOM）→ `tsc --noEmit` → `tsc`（build）→ `tsc -p tsconfig.client.json`（浏览器半边类型检查）→ `node scripts/build-client.mjs`（生成 `dist/client.js`）→ 包入口点（`main` / `types` / `exports` / `dsh.bundle.patch` 指向的文件存在，且 `dependencies` 为空）→ 测试面计数 → `node --test` → 用例数核对。`dist/client.js` 由门禁现建：它是 `exports['./client']` 的目标，且 `dist/` 不纳管，干净检出时不存在。

测试面：`tests/` 下递归共 **12** 个 `*.test.mjs`，必须与脚本里的 `EXPECTED_TEST_FILES` 集合相等，也必须等于本行声明的数字（`declaredTestCount()` 解析本行）。少一个、多一个、改名一个都会让门禁在跑测试前就停——不允许「测试变少、门禁仍绿」。

测试用例：`node --test` 汇总的用例总数共 **220** 个（`ℹ tests 220`），必须与脚本里的 `EXPECTED_TEST_CASES` 相等，也必须等于本行声明的数字（`declaredCaseCount()` 解析本行）。文件清单看不见文件内部：删掉一个 `test()` 块，剩下的用例照样全绿，所以用例数要单独锁一次——门禁读到 `ℹ tests` 的数字与本行不符时直接判红。

受控文件：`git ls-files` 共 **39** 个 = 15 个 `src/**` 源文件（`index.ts`、`diagnostics.ts`、`doctor.ts`、`selection.ts`、`provider/{config,error-codes,zcode}.ts`、`session/{file-store,store}.ts`、`web/router.ts`、`zcode/{billing,http-channel,parser,prefix,process}.ts`）+ 2 个 `client/` 源文件（`index.ts`、`locales.ts`）+ 12 个 `tests/**/*.test.mjs` + 3 个 `scripts/`（`run-tests.mjs`、`build-client.mjs`、`install-env.ps1`）+ 1 个 `docs/dsh-provider-contract.md` + 6 个根级文件（`.gitignore`、`README.md`、`cordis.patch.yml`、`package.json`、`tsconfig.json`、`tsconfig.client.json`）。门禁会拿 `git ls-files` 的实点数与这一行比对，改文件数必须同步改这行。

## 已知限制

- **L1 未验证成功路径**：账号 1309，`-p` 成功时的 stdout 形状（NDJSON 还是整段 JSON）没有读数，因此 `parseStdout()` 的口径是结构推定，不是实测。
- **L2 未验证 sessionId**：拿不到 `sess_…` 的稳定来源，`sessionMode: resume` 因此不可用，默认 `full`。
- **L3 未验证 `--mode guarded` 非交互行为**：要求写文件的 prompt 在守护模式下的表现（挂起 / 排队 / 被拒）未观测。
- **L4 未验证 150% 计费**：产品目标要求的倍率没有服务端账单读数，**禁止用本地文件推断计费**。
- **L5 不判权益**：doctor 与运行时都不判断套餐状态，1309 只作为历史观测记录。
- **L6 错误码语义待校准**：`3007` / `3012` 的真实语义（风控还是权限）未核对，映射可能需微调。
- **L7 workspace 解析可能拿不到**：`--cwd` 现在取自 `sessions.get(id).header.cwd` → `workspaceRegistry.resolveByPath()` → `status() === 'ok'`。宿主没有该 session、registry 返回 undefined、目录已删或 status 非 `ok` 时，本 provider **fail-closed**（`WORKSPACE_UNAVAILABLE`，不退回 `process.cwd()`）。因此「会话目录不可用」的表现是明确报错，而不是在 DSH 安装目录里跑。
- **L8 工具面由 CLI 自己管**：`toolPolicy: reject` 只拒绝**下发 DSH 的工具 schema**；它关不掉 ZCode CLI 自身的工具能力。`--mode guarded` 下 CLI 内部工具（读写文件、执行命令）的行为**未验证**（账号 1309，无法实测）。因此本文档**不宣称「工具已禁用」**，只说「DSH 侧的工具调用不会被下发、也不会被接受」。
- **L9 prompt 在进程命令行可见**：ZCode 的 `-p` 形态把整轮 prompt 放进 argv，同机其他进程读得到命令行。这是 CLI 协议固有，本 provider 无法规避；不要把凭据写进 prompt。
- **L10 原子写只在单进程内有效**：`sessions.json` 用 `tmp + rename` 并带 `pid + uuid` 临时名，能防半写与名字碰撞；没有跨进程锁，同一 `sessionStorePath` 被两个 DSH 实例同时写不是一个受支持的情形。
- **L11 额度面板依赖凭据可解密**：面板复用 ZCode CLI 写入 `credentials.json` 的 token。用 `ZCODE_CREDENTIAL_SECRET` 登录、之后又换了该变量（或换了 OS 账号），解密会失败并显示 `ZCODE_CREDENTIAL_DECRYPT_FAILED`——这不是插件坏了，重新登录或改回原 secret 即可。跨机器复制 `credentials.json` 同理不可用（key 派生自本机指纹）。
- **L12 面板是只读读数的时点快照**：30 秒进程内缓存意味着「到期 / 剩余」最多滞后 30 秒；`?refresh=1` 只跳过缓存，不能强制服务端重算。路由只对 loopback 开放（403 拒绝其他对端），但没有额外的鉴权层——能访问本机 HTTP 端口的进程就能读到额度读数。
- **L13 额度面板不判权益**：它只展示服务端返回的 plans / balances，不用来拦截请求；套餐到期仍由 CLI 侧 stderr 的 `[1309]` 体现（见 L5）。
