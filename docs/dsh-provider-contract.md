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
- 不支持的字段不能静默丢弃，必须抛带稳定 code 的 `ZcodeError`。默认 `toolPolicy: dsh-owned` 下工具 schema 照常下发并投影回 DSH；`reject` 下非空 `tools` 报 `UNSUPPORTED_TOOLS`，image/file block 报 `UNSUPPORTED_CONTENT`——两条都在 spawn 之前生效。`temperature` / `maxTokens` / 非空 `stop` 报 `UNSUPPORTED_OPTION`：CLI 的 `-p` 协议没有这三个字段的入口。
- `toolPolicy: dsh-owned`（默认）把 DSH 的工具 schema 下发，stdout 里的 tool frame 投影成 `block-start(tool-call) → tool-call-delta* → block-end(tool-call)` 并以 `finish{tool-calls}` 收尾；`zcode-owned` 丢弃 schema 后继续，但 stdout 若仍回 tool frame 则 fail-closed；`reject` 直接拒绝带 tools 的回合。两种宽松策略下 image/file 投影为占位文本（`[图片附件 … 图片内容未发送]`），不静默丢失。
- `reasoningEffort` 不映射到 CLI（`-p` 协议没有该通道）：卡片上选中的 effort 只写进 selection.json，不改变任何一次 spawn 的 argv。

## 传输通路（唯一：CLI 委托）

**只有一条通路：spawn 官方 `zcode.cjs`。** 这是用户 2026-10-24 定的口径（"HTTP 肯定不能用……我只走 C 的，不可能走 HTTP 的"），理由有三层：① 只有官方二进制自己带 ed25519 客户端请求签名，第三方 HTTP 无论伪装多少请求头都过不了 Coding Plan 档的签名校验；② 免费 Start Plan 端点对无签名请求会回 `405 [3012] request has been blocked due to unusual activity`，且带账号惩罚阶梯（30 分钟 → 24 小时 → 停用）；③ 进程委托不持有、不解密任何凭据——与 `dsh-agy-provider` 同一条合规底线。

因此 `config.channel` 这个概念**已整体删除**（含 `free` / `paid` 两个 HTTP 通道、`src/zcode/http-channel.ts`、`src/zcode/billing.ts`、`ZCODE_HTTP` 一族错误码、`/plugins/zcode-provider/billing` 路由）。HTTP 直连在 2026-10-24 14:50 曾跑通过两轮工具闭环，随后被 3012 风控永久标记，不再作为任何路径保留。

浏览器端卡片上的「套餐」下拉（`free` / `paid`）**不是传输选择，是标签**：两条都 spawn 同一条命令，实际走哪个套餐由 ZCode 自己的状态文件决定——`<ZCODE_DATA_BASE_DIR>/.zcode/v2/setting.json` 的 `providerFamilyConnectionSelections.<family>.kind`（`start-plan` / `individual-coding-plan` / `team-coding-plan`）与同目录 `provider_config.json` 的 `defaultModelSelection`。插件**只读**这两个文件（`src/zcode/profile.ts`），从不写：那是另一个应用的状态，且 `provider_config.json` 里带着它的 API key。

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

`ZCODE_ERROR_CODES` 共 **17** 个。stderr 那一半错误只从 stderr 文本解析（`classifyStderr()`），provider 数字码保留在 `ZcodeError.providerCode`；`ZCODE_CREDENTIAL_*` / `ZCODE_BILLING_*` / `ZCODE_HTTP` 一族随 HTTP 直连通道整体删除（2026-10-24），本表已无任何非 CLI 来源的错误码。

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

## 浏览器端卡片（client half）

宿主给「设置 → 模型」里每个 provider 行渲染槽 `settings.models.provider-card`，槽位**没有回退表单**：找不到与 `entryKey` 匹配的卡片时行体就是空的。所以本包必须带一个浏览器半边，否则后端再正常，设置页里 ZCode 那一行也是空白。

- 入口：`client/index.ts`（源码）→ `scripts/build-client.mjs`（TypeScript 编译器 API 打包）→ `dist/client.js`（单文件 ESM，`dist/` 被 gitignore，门禁构建它）。`package.json` 声明 `dsh.client = { inject: ['@deepseek-ai/dsh-client-ui-primitives'], platform: 'web' }` 与 `exports['./client']`。
- 槽键：`ctx.slots.register({ name: 'settings.models.provider-card', key: 'dsh-zcode-provider', id: 'zcode-provider-card' }, …)`。`key` 必须**逐字等于** Node 半边的 `ZCODE_SETTINGS_NS`（`src/index.ts`），宿主按这个字符串匹配，写错一个字符就回到空白行。
- 槽位 props 只有 `{ provider, configured, keyConfigured }`，**不含配置本体**（配置在同一个槽的兄弟表单里）。卡片上半部分是**运行配置块**（套餐 / 模型 / 推理强度三个 `<select>`，读写插件自己的 loopback state 路由），下半部分是**只读信息面板**：路由 / 命名空间 / 模型目录 / 随包默认值（`sessionMode` / `toolPolicy` / `mode` / `imageInput`）/ CLI 入口（`node` 与 `zcode.cjs` 绝对路径）/ 环境契约五变量。除该 state 路由外，卡片不读写宿主配置，也不碰任何 ZCode 文件。
- state 路由契约：`GET`/`POST /plugins/dsh-zcode-provider/state`（`ZCODE_STATE_ROUTE_PATH`，`src/web/router.ts`；客户端字面量 `STATE_PATH`，`tests/client.test.mjs` 钉住两者相等）。成功信封 `{ ok: true, state: { plan, model, effort, plans[], models[], efforts[] }, error: null }`；失败 `{ ok: false, error: { code, message } }`；无法识别的值回 `400` + `error.code = 'INVALID_SELECTION'`。客户端 `readSelectionEnvelope()` 只接受 `ok === true` 且 `state` 齐备，否则渲染成一行失败提示而不是静默空白。
- 选项语义：`plans` 两个（`free` 免费套餐 / `paid` 付费套餐）在 CLI 单通路下是**标签**，切换不改变 spawn 的 argv。`model` 与 `effort` 同样不改变 argv——0.17.0 的 CLI 没有 `--model` / `--effort` 旗标，实际跑哪个模型由 ZCode 自己的 `provider_config.json`（插件只读）决定。selection 的作用是**让卡片的选择与守卫一致**：请求模型与选择模型或配置默认模型都不相等时才 `MODEL_NOT_FOUND` 且不 spawn。
- 样式：`client/styles.ts` 导出 `ZC_CSS`，由卡片在渲染树里 `h('style', null, ZC_CSS)` 注入；下拉样式照抄 `F:\defws\dsh-agy-provider\client\index.ts` 的 `.agy-select`（改名 `zc-select`，连同 `:root` 亮/暗色变量与 `.zc-btn`），这是用户明确要求「参考我已经做好的，不要自己造轮子」的落点。
- Hook 纪律：`useState` / `useEffect` 只在组件上方的 `useTranslation()` 与 `useSelection()` 里，组件函数体**只有两句 hook（都在首行区）、只有一个 return**。宿主用 `SlotErrorBoundary` 包住槽内容，渲染期抛异常会渲染成空元素——hook 在条件 return 之后导致 hook 数变化时，症状与本卡片要修的空白行一模一样。`tests/client.test.mjs` 把这条结构钉住。
- 漂移防线：卡片不能 import `src/provider/config.ts`（会拖入 schemastery 与适配器模块图，浏览器侧无法解析），所以模型目录、默认值与环境契约是**手抄字面量**；`tests/client.test.mjs` 逐项与 `src/` 和 `cordis.patch.yml` 比对，任一侧改了没同步就判红。

## 门禁

`node scripts/run-tests.mjs` 是唯一入口，顺序固定：AC11（`client/`、`src/`、`tests/`、`scripts/`、`docs/` 与根级文本文件全部 LF、无 BOM）→ `tsc --noEmit` → `tsc`（build）→ `tsc -p tsconfig.client.json`（浏览器半边类型检查）→ `node scripts/build-client.mjs`（生成 `dist/client.js`）→ 包入口点（`main` / `types` / `exports` / `dsh.bundle.patch` 指向的文件存在，且 `dependencies` 为空）→ 测试面计数 → `node --test` → 用例数核对。`dist/client.js` 由门禁现建：它是 `exports['./client']` 的目标，且 `dist/` 不纳管，干净检出时不存在。

测试面：`tests/` 下递归共 **13** 个 `*.test.mjs`，必须与脚本里的 `EXPECTED_TEST_FILES` 集合相等，也必须等于本行声明的数字（`declaredTestCount()` 解析本行）。少一个、多一个、改名一个都会让门禁在跑测试前就停——不允许「测试变少、门禁仍绿」。

测试用例：`node --test` 汇总的用例总数共 **161** 个（`ℹ tests 161`），必须与脚本里的 `EXPECTED_TEST_CASES` 相等，也必须等于本行声明的数字（`declaredCaseCount()` 解析本行）。文件清单看不见文件内部：删掉一个 `test()` 块，剩下的用例照样全绿，所以用例数要单独锁一次——门禁读到 `ℹ tests` 的数字与本行不符时直接判红。

受控文件：`git ls-files` 共 **42** 个 = 16 个 `src/**` 源文件（`index.ts`、`diagnostics.ts`、`doctor.ts`、`selection.ts`、`provider/{config,error-codes,zcode}.ts`、`session/{file-store,store}.ts`、`web/router.ts`、`zcode/{account-config,app-server,credential,parser,prefix,process}.ts`）+ 3 个 `client/` 源文件（`index.ts`、`locales.ts`、`styles.ts`）+ 13 个 `tests/**/*.test.mjs` + 3 个 `scripts/`（`run-tests.mjs`、`build-client.mjs`、`install-env.ps1`）+ 1 个 `docs/dsh-provider-contract.md` + 6 个根级文件（`.gitignore`、`README.md`、`cordis.patch.yml`、`package.json`、`tsconfig.json`、`tsconfig.client.json`）。门禁会拿 `git ls-files` 的实点数与这一行比对，改文件数必须同步改这行。

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
