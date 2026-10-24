/**
 * Locale dictionaries for the ZCode provider card.
 *
 * `NS` is the *locale* namespace the card registers its strings under. It is
 * deliberately the same string as `ZCODE_SETTINGS_NS` in `src/index.ts`, but
 * the two are separate contracts: the slot key (what the host matches the
 * provider row by) is `SETTINGS_NS` in `client/index.ts`, this one only names
 * the dictionary. Keeping them equal is a convenience, not the requirement.
 *
 * Simplified Chinese is the key source; `en` must be a complete dictionary or
 * `tsc -p tsconfig.client.json` fails.
 */

export const NS = 'dsh-zcode-provider'

export const zh = {
  'card.title': 'ZCode',
  'card.badge.on': '已在目录中',
  'card.badge.off': '未在目录中',
  'card.badge.unknown': '状态未知',
  'card.route': '提供方路由',
  'card.ns': '设置命名空间',
  'card.models': '模型目录',
  'card.models.catalog': '目录',
  'card.models.default': '默认',
  'card.defaults': '当前取值',
  'card.defaults.model': '默认模型',
  'card.defaults.sessionMode': '会话模式',
  'card.defaults.sessionMode.value': 'full（每轮重放完整历史；resume 复用 ZCode 会话 id，未验证）',
  'card.defaults.toolPolicy': '工具归属策略',
  'card.defaults.toolPolicy.value': 'reject（不下发 DSH 工具 schema）',
  'card.defaults.mode': 'CLI 权限模式',
  'card.defaults.mode.value': 'guarded（固定；yolo 在配置里不可达）',
  'card.defaults.imageInput': '图片输入',
  'card.defaults.imageInput.value': 'off（0.17.0 无已验证的图片传输）',
  'card.defaults.source': '以上是插件内置默认值。宿主卡片槽只下发 provider / configured / keyConfigured，不下发配置本身；真实生效值以「编辑」表单里保存的为准。',
  'card.cli': 'CLI 入口',
  'card.cli.node': 'Node 可执行文件',
  'card.cli.cjs': 'ZCode 入口脚本',
  'card.env': '环境契约',
  'card.env.hint': '由启动 DSH 宿主的进程提供。缺值或值不对时，插件在 spawn 之前就 fail-closed 拒绝，不会静默降级。NODE_OPTIONS 是唯一一项由插件自己补齐的（两个 DNS 旗标）。',
  'card.env.ZCODE_HOME': 'ZCode 引导根目录（缺失时 CLI 起不来）',
  'card.env.ZCODE_DATA_BASE_DIR': 'ZCODE_HOME 的父目录（同一引导步骤要用）',
  'card.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE': '内置 provider 配置（缺失时 CLI 约 714 ms 内退出）',
  'card.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE': '个人 provider 配置（与内置那份必须成对提供）',
  'card.env.NODE_OPTIONS': 'IPv4 优先 DNS；值级白名单，只接受这两个旗标',
  'card.quota': '本机 Coding Plan 若已到期，发消息会报 [1309]（服务端权益，非插件问题）。',
  'card.noRoute': '本插件没有 web 路由：这张卡片只渲染静态信息，不发任何网络请求。',
  'card.placeholder': '—',
} as const

/** Every key the card may ask for. */
export type ZcodeLocaleKey = keyof typeof zh

/** A complete dictionary; a missing key is a type error, not a fallback. */
export type ZcodeDictionary = Record<ZcodeLocaleKey, string>

export const en: ZcodeDictionary = {
  'card.title': 'ZCode',
  'card.badge.on': 'In the directory',
  'card.badge.off': 'Not in the directory',
  'card.badge.unknown': 'State unknown',
  'card.route': 'Provider route',
  'card.ns': 'Settings namespace',
  'card.models': 'Model catalog',
  'card.models.catalog': 'Catalog',
  'card.models.default': 'default',
  'card.defaults': 'Current values',
  'card.defaults.model': 'Default model',
  'card.defaults.sessionMode': 'Session mode',
  'card.defaults.sessionMode.value': 'full (replays the whole history each turn; resume reuses a ZCode session id and is unverified)',
  'card.defaults.toolPolicy': 'Tool policy',
  'card.defaults.toolPolicy.value': 'reject (no DSH tool schema is sent down)',
  'card.defaults.mode': 'CLI permission mode',
  'card.defaults.mode.value': 'guarded (fixed; yolo is unreachable through config)',
  'card.defaults.imageInput': 'Image input',
  'card.defaults.imageInput.value': 'off (0.17.0 has no verified image transport)',
  'card.defaults.source': 'These are the plugin defaults. The host card slot passes only provider / configured / keyConfigured — never the config itself — so the value actually in effect is the one saved in the Edit form.',
  'card.cli': 'CLI entry points',
  'card.cli.node': 'Node executable',
  'card.cli.cjs': 'ZCode entry script',
  'card.env': 'Environment contract',
  'card.env.hint': 'Supplied by whatever launches the DSH host. A missing or wrong value is refused fail-closed before a child process exists; nothing degrades silently. NODE_OPTIONS is the only entry the provider completes itself (two DNS flags).',
  'card.env.ZCODE_HOME': 'ZCode bootstrap root (the CLI will not start without it)',
  'card.env.ZCODE_DATA_BASE_DIR': 'Parent of ZCODE_HOME (the same bootstrap step needs it)',
  'card.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE': 'Built-in provider config (when missing the CLI exits within ~714 ms)',
  'card.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE': 'Personal provider config (must be supplied together with the built-in one)',
  'card.env.NODE_OPTIONS': 'IPv4-first DNS; value-level allowlist, only these two flags pass',
  'card.quota': 'If this machine\'s Coding Plan has expired, sending a message reports [1309] — that is the server-side entitlement, not a plugin fault.',
  'card.noRoute': 'This plugin has no web route: the card renders static information and performs no network request.',
  'card.placeholder': '—',
}
