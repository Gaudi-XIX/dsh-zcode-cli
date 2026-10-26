# dsh-zcode-cli

DSH 的 **safe provider**：把本机 ZCode CLI（`zcode.cjs`，ZCode 0.17.0）作为一个 `zcode` 路由接进 DSH 的 LLM 层。一个 `LlmAdapter`，无运行时依赖（`dependencies` 为空），Node ≥ 22。

**这个插件的三件事（三件全部成立，第三件分两步走）：**

1. **完全合规** ✓ —— 插件自己从不向上游发一个网络请求：所有流量由官方二进制自带 ed25519 签名发起；不碰 ZCode 的账号密码，不伪造客户端特征。零风控、零封号面。
2. **吃到 ZCode 账号的官方额度** ✓ —— 付费套餐走官方签名通道；免费起步套餐经 app-server 账号注入，且注入层已**端到端激活**（对照官方桌面客户端的投递载荷修复了 canonical revision、connectionKey 与 runtime 上报的 builtin tag，实测模型可在免费套餐上跑完整轮次）。消耗与官方客户端同池同规则，不需要任何 API Key。
3. **抛弃 ZCode 的 harness 换 DSH 的：协议已通，产品化在路上** —— 实测（probe5，2026-10-26）：免费套餐上的模型**可以经 MCP 桥调用工具**，与姊妹插件 dsh-agy-cli 的桥同构。「ZCode 不开放工具投影」的旧判断已被实测推翻。当前版本 harness 仍归 ZCode（DSH 提供壳层：会话组织、重试、错误分类、随时切走）；把 DSH 工具桥产品化（工具投影 + 审批/沙箱经 DSH ToolRuntime）是下一步。在那之前，**多步工具任务请走 [`dsh-agy-cli`](https://github.com/Gaudi-XIX/dsh-agy-cli)**（harness 已 100% 归 DSH）。

## 与其他服务商插件的区别（先读这个）

DSH 生态里接第三方模型的插件，本质差异只有一个问题：**谁来当 harness**。harness 指「工具怎么执行、多步循环怎么走、上下文怎么管」这三件事。两个插件正好站在光谱两端：

| | [dsh-agy-cli](https://github.com/Gaudi-XIX/dsh-agy-cli)（姊妹插件） | **本插件（当前版本）** | 抽 token 反代类插件 |
|---|---|---|---|
| 模型额度来源 | AGY CLI 官方二进制 | ZCode CLI 官方二进制 | 逆向出的私token |
| **harness 归属** | **DSH 100% 主导** | **暂归 ZCode CLI**（MCP 工具桥已实测可通，产品化在路上） | 插件自建 |
| 工具执行 | DSH 工具管线（审批/沙箱全生效） | ZCode 内部工具（`--mode guarded` 委托给它） | 插件自实现 |
| 网络请求 | 官方二进制签发 | 官方二进制签发 | 插件伪造客户端直连 |
| 风控/封号面 | 无 | 无 | 有（如 ZCode 通道 `405 [3012]` 惩罚阶梯） |
| DSH harness 增强（审批、沙箱、子代理、压缩） | **全部生效** | **暂够不着**（工具桥产品化后生效） | 部分自实现 |

**为什么当前版本还是「CLI 主导」——旧判断与它的实测推翻。** AGY CLI 暴露了 stream-json 事件协议和结构化 tool-call 信封，所以 agy 插件能把 DSH 的工具 schema 投影进去、把模型要调的工具拦截下来交回 DSH 执行。本插件最初据此判断「ZCode 没有这种通道」：它只卖「跑一轮任务」（`-p` 一次性 / app-server 会话），不卖裸模型接口，额度又绑定官方签名通道。**这个判断已被实测推翻**（2026-10-26 probe5：免费套餐上的模型经 MCP 桥成功调用工具，与 agy 的桥同构）——app-server 通道具备 MCP 工具桥能力，DSH 工具桥的产品化（工具投影、审批、沙箱接 DSH ToolRuntime）是明确的下一步。在那之前，本插件的形态是：整轮任务委托给 ZCode，DSH 做好壳层（会话组织、重试、超时、错误分类、UI、随时切走）。

### 与市场同类的对照

DSH 市场里已有两条同走官方 CLI 委托路线的 ZCode 插件，都是认真维护的作品，收录本插件前先说清它们为什么不同：

- [`dsh-zcode-cli-proxy`](https://github.com/kyle123740/dsh-zcode-cli-proxy) / [`dsh-zcode-plan-bridge`](https://github.com/tangyixiao/dsh-zcode-plan-bridge)：单路线常驻 app-server（Start Plan 账号注入），真流式，跟进 ZCode CLI 新版（3.16.x）与 DSH 0.2.1 更激进。**适合想让 ZCode 会话常驻、跟进新 CLI 的用户。**
- **本插件**锚定已实测的 ZCode 0.17.0 + DSH 0.2.0-rc.2，做的是另一件事：**付费（`-p` 一次性）与免费（app-server 注入）双路线**，且把两条路线的行为逐一对齐（resume 语义、死会话自愈、准入检查、错误码），以 173 例 node --test 测试和三处计数的门禁锁死，每条行为有契约文档（`docs/dsh-provider-contract.md`）背书。**适合要付费/免费可切、看重可测契约与 fail-closed 语义的用户。**

## 优势（这套设计换来什么）

- **零风控**：只走官方 CLI 的签名通道，不触碰任何可被识别为「非官方客户端」的行为。
- **多路由并存**：`zcode` 只是 DSH 模型列表里的一行——同一会话随时切回 DSH 原生 provider，ZCode 留作纯文本任务的额度补充。
- **双通道**：付费（及默认）走一次性 `-p` 子进程；免费起步套餐走 app-server 通道（插件把账号表注入进程、plan token 只在本机内存里交还官方 CLI 使用），两条都是官方二进制自签。
- **包装层全套**：fail-closed 准入（兑现不了的请求在 spawn 前拒绝）、稳定错误码、重试/超时看门狗、并发门、会话锁、resume 死会话自愈——两条路线行为对齐。
- **设置卡片可切换**：套餐 / 模型 / 推理强度三个下拉，写入插件自己的 loopback 路由，不重启生效，不写 ZCode 的任何状态文件。

## 劣势与代价（诚实清单）

- **DSH 的 harness 增强暂时够不着它**：审批 UI、沙箱策略、子代理编排对这条路线暂不生效。工具在 ZCode 内部跑，`--mode guarded` 的非交互行为未实测（见已知限制）。MCP 工具桥协议已实测可通（probe5），DSH 工具桥产品化后此项撤销；在那之前，**多步工具任务请用 harness 主导的姊妹插件 [`dsh-agy-cli`](https://github.com/Gaudi-XIX/dsh-agy-cli)，这条路线适合纯文本问答。**
- **一轮一进程**：每轮冷启动一个 CLI 子进程，首字延迟 1~3 秒；免费路线还要多付 app-server 就绪探针的时间。
- **prompt 走 argv 有 30,000 字符硬顶**（Windows 命令行上限）：`-p` 路线超长历史直接报错而不截断——宁可失败不答错题。免费路线走 stdin 无此限制。
- **模型切换受限**：CLI 没有 `--model`/`--effort`，付费路线下模型目录是静态的两个 id；免费路线经 app-server 真实下发。
- **若 ZCode 的 harness 本身弱，本插件救不了**：工具乱跑没人拦、上下文爆窗只能收到错误码。插件能做的只有把失败翻译成可读的错误。

## 它做什么

- 把 DSH 的一轮对话渲染成一段 prompt，付费路线用 `-p` 一次性交给 `zcode.cjs`（恒带 `--mode guarded`），免费路线经 app-server `session/send`。
- 把 ZCode 的输出帧按 DSH 的 `StreamChunk` 顺序投影（`block-start → delta* → block-end → usage → finish`），空输出与不可识别输出永不静默成功。
- 在**启动子进程之前**拒绝它兑现不了的请求：`tools`、`temperature`/`maxTokens`/非空 `stop`、`reject` 政策下的 image/file block，各配稳定错误码。
- 子进程环境是**闭集**：OS 基础变量白名单 + 五项契约值 + `passEnv`，宿主其他变量不外泄；`NODE_OPTIONS` 强制并入 ipv4-first DNS 修复，未知 flag 丢弃不透传。
- 设置页卡片读写插件自己的 loopback 路由 `GET`/`POST /plugins/dsh-zcode-cli/state`；「套餐」下拉自 2026-10-25 起是传输选择（免费＝app-server，付费＝`-p`），两者都是官方 CLI 子进程。

不做什么：不做模型发现（ZCode 没有免配额的模型列表）、不猜计费（150% 倍率无服务端读数前不宣称）、不伪造 sessionId、不写 ZCode 的 `setting.json` / `provider_config.json`。

## 安装

1. `pwsh -File scripts/install-env.ps1` 看 dry-run，确认后 `pwsh -File scripts/install-env.ps1 -Apply`（已存在且不同的变量默认跳过，需 `-Force` 覆盖）。
2. 在 profile 的 `package.json` `dependencies` 与 `cordis.patch.yml` 里加本包条目（改前备份）。
3. 重启 DSH（改插件源码同样需要重启才生效）。

细节、契约表与实测基线见 [`docs/dsh-provider-contract.md`](docs/dsh-provider-contract.md)。

## 门禁

```bash
node scripts/run-tests.mjs    # AC11 行尾 → tsc --noEmit → build → tsc client → build:client → 包入口点 → 测试面计数 → node --test
```

`tests/` 下 14 个 `*.test.mjs`；脚本里的显式清单、`docs/dsh-provider-contract.md` 的「测试面」计数与磁盘实点三者必须一致，否则门禁在跑测试前就停。用例总数同样锁死（173，`EXPECTED_TEST_CASES` 与文档「测试用例」行），删掉一个 `test()` 块也会让门禁变红。免费路线由一个实现了 app-server 协议的 fake CLI 端到端覆盖（流式/短答/resume/死会话/准入），浏览器半边字面量由 `tests/client.test.mjs` 逐项钉住。

## 已知限制（摘要）

- **工具隔离依赖 CLI 自身**：`toolPolicy: reject` 只拒绝下发 DSH 的工具 schema，关不掉 ZCode CLI 内部的工具能力；`--mode guarded` 下 CLI 内部工具行为**未验证**。本 provider **不宣称「工具已禁用」**。
- **prompt 在进程命令行可见**：`-p` 形态把整轮 prompt 放进 argv，同机其他进程可读。不要把凭据写进 prompt。
- **成功路径未实测**：账号返回 `1309`（套餐到期），`-p` 成功时的 stdout 形状、sessionId 获取、`guarded` 非交互行为、150% 计费均无读数（免费路线的 app-server sessionId 已可用）。
- **原子写仅单进程有效**：`sessions.json` 用带 `pid + uuid` 的临时名 + rename，无跨进程锁。

完整清单（L1–L10）见 `docs/dsh-provider-contract.md` 的「已知限制」。
