import z from '@deepseek-ai/schemastery'

/** Ownership policy for DSH tool schemas on the ZCode route. */
export type ZcodeToolPolicy = 'reject' | 'zcode-owned' | 'dsh-owned'

/** Image attachment mode; ZCode 0.17.0 has no verified image transport yet. */
export type ZcodeImageInput = 'off' | 'experimental'

/**
 * ZCode CLI permission mode.
 *
 * Deliberately a one-member union: `yolo` exists in the CLI but auto-approves
 * every tool call, and a provider that runs unattended must not be able to
 * reach it through configuration. The argv builder asserts the same invariant.
 */
export type ZcodeMode = 'guarded'

/**
 * Transport that serves a request.
 *
 * `cli` spawns `resources/glm/zcode.cjs` and inherits the CLI's own login.
 * `free` and `paid` speak the Anthropic Messages endpoint directly — one HTTP
 * request instead of one process — and differ only in identity: `free` uses the
 * encrypted credential store the CLI maintains (device-bound), `paid` uses an
 * API key from the environment.
 */
export type ZcodeChannel = 'cli' | 'free' | 'paid'

/** The two channels that authenticate over HTTP; `cli` is not one of them. */
export type ZcodeCredentialChannel = Exclude<ZcodeChannel, 'cli'>

/** `output_config.effort` of the Messages request; the capture used `max`. */
export type ZcodeEffort = 'low' | 'medium' | 'high' | 'max'

/** Default channel: the spawned CLI, i.e. the path the earlier batches verified. */
export const DEFAULT_CHANNEL: ZcodeChannel = 'cli'

/** Default effort for the HTTP channels; `high` trades fewer tokens for less depth than `max`. */
export const DEFAULT_EFFORT: ZcodeEffort = 'high'

/** Paid (`open.bigmodel.cn`) Messages deployment; override with `paidBaseUrl`. */
export const DEFAULT_PAID_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'

/**
 * Environment variable holding the paid channel's API key.
 *
 * Deliberately not a config field: a profile file is copied, pasted into
 * issues and committed; an environment variable is the narrower blast radius.
 */
export const ZCODE_PAID_API_KEY_ENV = 'ZCODE_PAID_API_KEY'

/** Environment variable naming the ZCode *data* root (`<root>/.zcode/v2/...`). */
export const ZCODE_DATA_BASE_DIR_ENV = 'ZCODE_DATA_BASE_DIR'

export interface ModelConfig {
  /** Exact model id passed to ZCode. */
  id: string
  /** Optional selector label; defaults to `id`. */
  name?: string
  /** Optional selector description. */
  description?: string
  /** Optional provider-declared combined context capacity. */
  contextWindow?: number
}

export interface ZcodeRetryPolicyConfig {
  /** Eligible retries after the first ZCode process; hard capped at DSH's default of 5. */
  maxRetries?: number
  /** Delay before attempt N+1, multiplied by N where backoff is linear. */
  backoffMs?: number
  /** Stable transient codes allowed to consume another ZCode attempt. */
  retryableCodes?: string[]
}

export interface Config {
  /** Keep the bundle inert until explicitly enabled. */
  enabled?: boolean
  /** DSH provider route owned by this plugin. */
  provider?: string
  /**
   * Transport that serves requests. `cli` (default) spawns the ZCode CLI;
   * `free` / `paid` call the Messages endpoint directly. The default stays
   * `cli` so an existing profile keeps its verified behaviour.
   */
  channel?: ZcodeChannel
  /** `output_config.effort` for the HTTP channels; the CLI channel ignores it. */
  effort?: ZcodeEffort
  /** Paid channel base URL; `/v1/messages` is appended when the path is absent. */
  paidBaseUrl?: string
  /** ZCode model passed to the CLI when a request does not override it. */
  model?: string
  /** Explicit model catalog; `model` remains the default/fallback entry. */
  models?: ModelConfig[]
  /** Visible models filter; empty means show every catalog entry. */
  visibleModels?: string[]
  /**
   * Model discovery mode. `off` is the only supported value: ZCode 0.17.0 has
   * no quota-free model listing command, so a discovery path would have to
   * spend a real turn (and a real quota unit) to enumerate anything.
   */
  modelDiscovery?: 'off'
  /** Ownership policy for DSH tool schemas; ZCode stays the internal tool owner. */
  toolPolicy?: ZcodeToolPolicy
  /** CLI permission mode; fixed to `guarded`. */
  mode?: ZcodeMode
  /** `resume` reuses a ZCode session id, `full` replays the whole history. */
  sessionMode?: 'resume' | 'full'
  /** Durable sessionId to conversationId map path; empty uses DSH_HOME/zcode-provider/sessions.json. */
  sessionStorePath?: string
  /** Extra host environment variable names the child may inherit (closed allowlist otherwise). */
  passEnv?: string[]
  /** Image input mode. */
  imageInput?: ZcodeImageInput
  /** Node executable that runs the ZCode entry script. */
  nodePath?: string
  /** ZCode CLI entry script (`resources/glm/zcode.cjs`). */
  zcodeCjsPath?: string
  /**
   * Backstop for one ZCode child process: the ceiling on total wall time. Only
   * a process whose output *never stops* can reach it, because the idle
   * watchdog below decides every normal case.
   */
  timeoutMs?: number
  /**
   * Inactivity budget for one ZCode child process: killed when no stdout/stderr
   * output arrives for this long. Re-armed on every chunk, so a long reasoning
   * step is never mistaken for a hang. MUST stay below `timeoutMs`: both timers
   * are armed inside the same process, so a wall clock that expires first makes
   * this watchdog unreachable and every healthy long turn dies as `timeout`.
   */
  idleTimeoutMs?: number
  /**
   * How the request pipe is retired after the prompt is written. `-p` is a
   * one-shot prompt, so `hold` keeps stdin open until the child exits and
   * `close` ends it as soon as the prompt is written.
   */
  stdinMode?: 'hold' | 'close'
  /** Max concurrent ZCode processes. */
  maxConcurrent?: number
  /** Max queue length in front of the concurrency gate. */
  maxQueue?: number
  /** Queue timeout ms. */
  queueTimeoutMs?: number
  /** Max captured stdout bytes before the process is killed as `output-limit`. */
  maxOutputBytes?: number
  /** Max length of one stdout event line. */
  maxEventLineLength?: number
  /** Retry policy consumed by the DSH retry executor. */
  retryPolicy?: ZcodeRetryPolicyConfig
}

// Keep the default route policy aligned with @deepseek-ai/dsh-llm.
// The DSH retry executor owns the retry loop; this list only declares which
// stable provider failures are eligible for that executor.
//
// QUOTA is deliberately absent: a 1309 ("plan expired") never clears on its
// own, so retrying it only multiplies the failures the user sees. AUTH is
// absent for the same reason — an invalid identity needs a new credential, not
// another process. ZCODE_EXIT stays eligible because a ZCode process that dies
// early (env not yet warm, transient spawn failure) genuinely succeeds on the
// next attempt.
export const ZCODE_RETRYABLE_CODES = [
  'RATE_LIMIT',
  'TIMEOUT',
  'ZCODE_EXIT',
  'ZCODE_UNKNOWN',
] as const
export type ZcodeRetryableCode = typeof ZCODE_RETRYABLE_CODES[number]

/** Static catalog verified against ZCode 0.17.0's configured providers. */
export const DEFAULT_MODELS: readonly ModelConfig[] = [
  { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' },
  { id: 'GLM-5.3', name: 'GLM-5.3' },
]

/** Default model id handed to ZCode when a request does not override it. */
export const DEFAULT_MODEL = 'GLM-5.3-Flash'

/** Measured Node major floor: `node:sqlite` (used by ZCode 0.17.0) needs >= 22. */
export const DEFAULT_NODE_PATH = 'D:\\nodejs\\node.exe'

/** Verified ZCode CLI entry script for 0.17.0. */
export const DEFAULT_ZCODE_CJS_PATH = 'F:\\AgentData\\zcode\\cli\\resources\\glm\\zcode.cjs'

const ModelConfigSchema = z.object({
  id: z.string().pattern(/^\S(?:.*\S)?$/).required(),
  name: z.string().pattern(/^\S(?:.*\S)?$/),
  // Kept for YAML/API compatibility; the selector intentionally does not render it.
  description: z.string().hidden(),
  contextWindow: z.natural().min(1).max(10_000_000),
}) as unknown as z<ModelConfig>

const RetryPolicyConfig = z.object({
  maxRetries: z.natural().max(5).default(2),
  backoffMs: z.natural().min(0).max(60_000).default(1_000),
  // Deliberately open-ended: the allowlist must be able to grow without
  // rejecting every profile written against the previous list. Anything not in
  // ZCODE_RETRYABLE_CODES is dropped by the consumer.
  retryableCodes: z.array(z.string().pattern(/^[A-Z][A-Z0-9_]*$/)).min(1).default([...ZCODE_RETRYABLE_CODES]),
}) as unknown as z<ZcodeRetryPolicyConfig>

export function createConfigSchema(defaults: {
  enabled?: boolean
  toolPolicy?: ZcodeToolPolicy
} = {}): z<Config> {
  const defaultEnabled = defaults.enabled ?? false
  const defaultToolPolicy = defaults.toolPolicy ?? 'reject'

  const schemaBase = z.object({
    enabled: z.boolean().default(defaultEnabled).description('Enable ZCode provider').volatile(),
    // The route is fixed by this plugin and is not a user-facing setting.
    provider: z.string().default('zcode').description('Provider route id').hidden(),
    channel: z.union(['cli', 'free', 'paid'] as const).default(DEFAULT_CHANNEL).description('Transport: cli spawns the ZCode CLI, free and paid call the Messages endpoint directly'),
    effort: z.union(['low', 'medium', 'high', 'max'] as const).default(DEFAULT_EFFORT).description('output_config.effort sent by the HTTP channels (the CLI channel ignores it)'),
    paidBaseUrl: z.string().pattern(/^\S(?:.*\S)?$/).default(DEFAULT_PAID_BASE_URL).description('Paid channel base URL; /v1/messages is appended when absent').hidden(),
    model: z.string().default(DEFAULT_MODEL).description('Default model id'),
    // Explicit catalogs are an advanced YAML escape hatch; the UI uses the catalog.
    models: z.array(ModelConfigSchema).default([...DEFAULT_MODELS]).description('Explicit model catalog').hidden(),
    visibleModels: z.array(z.string().pattern(/^\S(?:.*\S)?$/)).default([]).description('Visible models filter; empty shows every catalog entry, non-empty only shows the listed ids'),
    // One-member union on purpose: no verified discovery command exists.
    modelDiscovery: z.union(['off'] as const).default('off').description('Model discovery; off keeps the static catalog'),
    toolPolicy: z.union(['reject', 'zcode-owned', 'dsh-owned'] as const).default(defaultToolPolicy).description('Tool ownership policy'),
    mode: z.union(['guarded'] as const).default('guarded').description('CLI permission mode (fixed: guarded; yolo auto-approves every tool call)'),
    sessionMode: z.union(['resume', 'full'] as const).default('full').description('Session mode: full replays history, resume reuses a ZCode session id'),
    sessionStorePath: z.string().default('').description('Durable sessionId to conversationId map path; empty uses DSH_HOME/zcode-provider/sessions.json'),
    passEnv: z.array(z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]).description('Extra host environment variable names passed to the ZCode child; the allowlist is closed by default').hidden(),
    imageInput: z.union(['off', 'experimental'] as const).default('off').description('Image input mode'),
    nodePath: z.string().pattern(/^\S(?:.*\S)?$/).default(DEFAULT_NODE_PATH).description('Node executable that runs the CLI; ZCode 0.17.0 needs node:sqlite, i.e. Node >= 22').hidden(),
    zcodeCjsPath: z.string().pattern(/^\S(?:.*\S)?$/).default(DEFAULT_ZCODE_CJS_PATH).description('ZCode CLI entry script (resources/glm/zcode.cjs)').hidden(),
    timeoutMs: z.number().min(1).max(3_600_000).default(900_000).description('Backstop wall clock per request ms; only an endless-output run can reach it').hidden(),
    idleTimeoutMs: z.number().min(1).max(3_600_000).default(300_000).description('Inactivity budget per request ms; re-armed on every output chunk. Must stay below timeoutMs').hidden(),
    stdinMode: z.union(['hold', 'close'] as const).default('hold').description('Keep the request pipe open until ZCode exits (hold) or end it as soon as the prompt is written (close)').hidden(),
    maxConcurrent: z.natural().min(1).max(64).default(4).description('Max concurrent ZCode processes').hidden(),
    maxQueue: z.natural().max(256).default(32).description('Max queue length').hidden(),
    queueTimeoutMs: z.natural().max(3_600_000).default(30_000).description('Queue timeout ms').hidden(),
    maxOutputBytes: z.natural().min(1_024).max(64 * 1024 * 1024).default(8 * 1024 * 1024).description('Max output bytes').hidden(),
    maxEventLineLength: z.natural().min(1_024).max(8 * 1024 * 1024).default(1_048_576).description('Max event line length').hidden(),
    retryPolicy: RetryPolicyConfig.default({
      maxRetries: 2,
      backoffMs: 1_000,
      retryableCodes: [...ZCODE_RETRYABLE_CODES],
    }).hidden(),
  })

  const localized = (schemaBase as any).i18n({
    'zh-CN': {
      enabled: { $description: '是否启用 ZCode 提供方' },
      provider: { $description: '提供方路由 ID（固定为 zcode）' },
      channel: { $description: '传输通道：cli=拉起 ZCode CLI（默认）, free=免费通道直连 Messages 端点（读 CLI 已登录的加密凭据）, paid=付费通道直连（读 ZCODE_PAID_API_KEY）' },
      effort: { $description: 'HTTP 通道发送的 output_config.effort；CLI 通道忽略此项' },
      paidBaseUrl: { $description: '付费通道的 base URL；缺少 /v1/messages 时自动补上' },
      model: { $description: '默认模型 ID' },
      models: { $description: '显式模型目录；条目为基础 ID，可覆盖名称与上下文窗口' },
      visibleModels: { $description: '可见模型过滤；为空时显示全部目录条目，非空时仅显示列出的 ID' },
      modelDiscovery: { $description: '模型发现；off 表示只用静态目录（ZCode 0.17.0 无免配额的列模型命令）' },
      toolPolicy: { $description: '工具所有权：reject=拒绝 DSH 工具, zcode-owned=由 ZCode 执行, dsh-owned=由 DSH 执行' },
      mode: { $description: 'CLI 权限模式（固定 guarded；yolo 会自动批准所有工具调用）' },
      sessionMode: { $description: '会话模式：full=每轮完整历史, resume=复用 ZCode 会话 ID' },
      sessionStorePath: { $description: '会话映射（DSH 会话→ZCode 会话）的落盘路径；留空用 DSH_HOME/zcode-provider/sessions.json，让 resume 模式在宿主重启后仍能续话' },
      passEnv: { $description: '额外允许传给 ZCode 子进程的宿主环境变量名；默认白名单之外一律不继承' },
      imageInput: { $description: '图片输入：off=关闭, experimental=实验通道' },
      nodePath: { $description: '运行 CLI 的 Node 可执行文件路径；ZCode 0.17.0 需要 node:sqlite，即 Node >= 22' },
      zcodeCjsPath: { $description: 'ZCode CLI 入口脚本（resources/glm/zcode.cjs）' },
      timeoutMs: { $description: '单次请求的墙上时钟上限（毫秒）' },
      idleTimeoutMs: { $description: '单次请求的无输出静默预算（毫秒）；每有一块输出即重新计时' },
      stdinMode: { $description: '请求管道收尾方式：hold=等 ZCode 自己退出再关（默认）, close=写完即关' },
      maxConcurrent: { $description: '最大并发 ZCode 进程数' },
      maxQueue: { $description: '最大排队长度' },
      queueTimeoutMs: { $description: '排队超时（毫秒）' },
      maxOutputBytes: { $description: '单次 ZCode 输出最大字节' },
      maxEventLineLength: { $description: '单行事件最大长度' },
      retryPolicy: { $description: '重试策略：可重试错误码、次数与退避' },
    },
    en: {
      enabled: { $description: 'Enable ZCode provider' },
      provider: { $description: 'Provider route id (always zcode)' },
      channel: { $description: 'Transport: cli spawns the ZCode CLI (default), free calls the Messages endpoint with the CLI login, paid calls it with ZCODE_PAID_API_KEY' },
      effort: { $description: 'output_config.effort sent by the HTTP channels; the CLI channel ignores it' },
      paidBaseUrl: { $description: 'Paid channel base URL; /v1/messages is appended when absent' },
      model: { $description: 'Default model id' },
      models: { $description: 'Explicit model catalog; entries are base ids' },
      visibleModels: { $description: 'Visible models filter; empty shows every catalog entry, non-empty only shows the listed ids' },
      modelDiscovery: { $description: 'Model discovery; off keeps the static catalog (ZCode 0.17.0 has no quota-free model listing)' },
      toolPolicy: { $description: 'Tool ownership: reject, zcode-owned, dsh-owned' },
      mode: { $description: 'CLI permission mode (fixed to guarded; yolo auto-approves every tool call)' },
      sessionMode: { $description: 'Session mode: full or resume' },
      sessionStorePath: { $description: 'Path of the durable DSH session to ZCode session map; empty uses DSH_HOME/zcode-provider/sessions.json so resume keeps working after a host restart' },
      passEnv: { $description: 'Extra host environment variable names inherited by the ZCode child; everything outside the allowlist is dropped' },
      imageInput: { $description: 'Image input: off, or the experimental channel' },
      nodePath: { $description: 'Node executable that runs the CLI; ZCode 0.17.0 needs node:sqlite, i.e. Node >= 22' },
      zcodeCjsPath: { $description: 'ZCode CLI entry script (resources/glm/zcode.cjs)' },
      timeoutMs: { $description: 'Per-request wall-clock ceiling (ms)' },
      idleTimeoutMs: { $description: 'Per-request inactivity budget (ms); re-armed on every output chunk' },
      stdinMode: { $description: 'How the request pipe is retired: hold=wait for ZCode to exit (default), close=end right after the prompt is written' },
      maxConcurrent: { $description: 'Max concurrent ZCode processes' },
      maxQueue: { $description: 'Max queue length' },
      queueTimeoutMs: { $description: 'Queue timeout (ms)' },
      maxOutputBytes: { $description: 'Max output bytes per ZCode process' },
      maxEventLineLength: { $description: 'Max event line length' },
      retryPolicy: { $description: 'Retry policy: eligible codes, attempts, backoff' },
    },
  })
  return localized
    .comment('其余字段在 cordis.patch.yml 中，请直接编辑对应段。 (dsh-zcode-provider)') as unknown as z<Config>
}

/** Programmatic library default: enabled=false, toolPolicy=reject. */
export const Config: z<Config> = createConfigSchema({ enabled: false, toolPolicy: 'reject' })

/** Bundle default for DSH profile plugin add: enabled=true, tools rejected. */
export const BundleConfig: z<Config> = createConfigSchema({ enabled: true, toolPolicy: 'reject' })

/**
 * Read a boolean config value that may be a volatile reference.
 *
 * `enabled` carries `.volatile()` so a settings change takes effect without a
 * restart. The host then hands `apply()` the reference object rather than the
 * primitive, and `reference === true` is *always* false — the exact bug that
 * kept the adapter unregistered. Both shapes are accepted here: a primitive
 * (programmatic config, tests) and any reference exposing a callable `get()`.
 */
export function configBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'object' && value !== null) {
    const getter = (value as { get?: unknown }).get
    if (typeof getter === 'function') return configBoolean((getter as () => unknown).call(value))
  }
  return false
}

/**
 * Resolve the effective catalog. Catalog membership is advisory; unknown exact
 * model ids remain valid request targets and are handled by the adapter's
 * resolveModel().
 */
export function configuredModels(
  config: { readonly model?: string | undefined; readonly models?: readonly ModelConfig[] | undefined } = {},
): readonly ModelConfig[] {
  const fallbackId = config.model?.trim() || DEFAULT_MODEL
  const entries = config.models !== undefined && config.models.length > 0
    ? config.models
    : [{ id: fallbackId }]
  const catalog: ModelConfig[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const id = entry.id.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    catalog.push({ ...entry, id })
  }
  if (!seen.has(fallbackId)) catalog.push({ id: fallbackId })
  return catalog
}

/** Filter catalog by visibleModels (empty = all). */
export function filterVisibleModels(models: readonly ModelConfig[], visibleModels: readonly string[] | undefined): readonly ModelConfig[] {
  if (visibleModels === undefined || visibleModels.length === 0) return models
  const allow = new Set(visibleModels.map(id => id.trim()))
  return models.filter(m => allow.has(m.id))
}
