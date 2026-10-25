# dsh-zcode-provider

DSH 的 **safe provider**：把本机 ZCode CLI（`zcode.cjs`，ZCode 0.17.0）作为一个 `zcode` 路由接进 DSH 的 LLM 层。一个 `LlmAdapter`，无运行时依赖（`dependencies` 为空），Node ≥ 22。

> **safe 在哪**：插件自己从不向上游发一个网络请求——所有流量都由官方二进制自带 ed25519 签名发起；不碰 ZCode 的账号密码，不伪造客户端特征，零风控、零封号面。

## 与其他服务商插件的区别（先读这个）

DSH 生态里接第三方模型的插件，本质差异只有一个问题：**谁来当 harness**。harness 指「工具怎么执行、多步循环怎么走、上下文怎么管」这三件事。两个插件正好站在光谱两端：

| | [dsh-agy-provider](https://github.com/Gaudi-XIX/dsh-agy-provider) | **本插件** | 抽 token 反代类插件 |
|---|---|---|---|
| 模型额度来源 | AGY CLI 官方二进制 | ZCode CLI 官方二进制 | 逆向出的私token |
| **harness 归属** | **DSH 100% 主导** | **ZCode CLI 主导** | 插件自建 |
| 工具执行 | DSH 工具管线（审批/沙箱全生效） | ZCode 内部工具（`--mode guarded` 委托给它） | 插件自实现 |
| 网络请求 | 官方二进制签发 | 官方二进制签发 | 插件伪造客户端直连 |
| 风控/封号面 | 无 | 无 | 有（如 ZCode 通道 `405 [3012]` 惩罚阶梯） |
| DSH harness 增强（审批、沙箱、子代理、压缩） | **全部生效** | **够不着**（进程边界外） | 部分自实现 |

**为什么本插件是「CLI 主导」而不是 agy 那种「DSH 主导」——这是上游接口决定的，不是实现取舍。** AGY CLI 暴露了 stream-json 事件协议和结构化 tool-call 信封，所以 agy 插件能把 DSH 的工具 schema 投影进去、把模型要调的工具拦截下来交回 DSH 执行。ZCode 0.17.0 没有这种通道：它只卖「跑一轮任务」（`-p` 一次性 / app-server 会话），不卖裸模型接口，也不吐工具投影；模型额度又绑定在官方二进制的签名通道上，HTTP 直连会被风控打回。**接口没开的门，插件侧任何实现都变不出来。** 所以本插件的形态是：整轮任务委托给 ZCode，DSH 做好的那一层壳（会话组织、重试、超时、错误分类、UI、随时切走）。

## 优势（这套设计换来什么）

- **零风控**：只走官方 CLI 的签名通道，不触碰任何可被识别为「非官方客户端」的行为。
- **多路由并存**：`zcode` 只是 DSH 模型列表里的一行——同一会话随时切回 DSH 原生 provider，ZCode 留作纯文本任务的额度补充。
- **双通道**：付费（及默认）走一次性 `-p` 子进程；免费起步套餐走 app-server 通道（插件把账号表注入进程、plan token 只在本机内存里交还官方 CLI 使用），两条都是官方二进制自签。
- **包装层全套**：fail-closed 准入（兑现不了的请求在 spawn 前拒绝）、稳定错误码、重试/超时看门狗、并发门、会话锁、resume 死会话自愈——两条路线行为对齐。
- **设置卡片可切换**：套餐 / 模型 / 推理强度三个下拉，写入插件自己的 loopback 路由，不重启生效，不写 ZCode 的任何状态文件。

## 劣势与代价（诚实清单）

- **DSH 的 harness 增强够不着它**：审批 UI、沙箱策略、子代理编排对这条路线全部无效。工具在 ZCode 内部跑，`--mode guarded` 的非交互行为未实测（见已知限制）。**多步工具任务请用 harness 主导的 provider（如 dsh-agy-provider），这条路线适合纯文本问答。**
- **一轮一进程**：每轮冷启动一个 CLI 子进程，首字延迟 1~3 秒；免费路线还要多付 app-server 就绪探针的时间。
- **prompt 走 argv 有 30,000 字符硬顶**（Windows 命令行上限）：`-p` 路线超长历史直接报错而不截断——宁可失败不答错题。免费路线走 stdin 无此限制。
- **模型切换受限**：CLI 没有 `--model`/`--effort`，付费路线下模型目录是静态的两个 id；免费路线经 app-server 真实下发。
- **若 ZCode 的 harness 本身弱，本插件救不了**：工具乱跑没人拦、上下文爆窗只能收到错误码。插件能做的只有把失败翻译成可读的错误。

## 它做什么

- 把 DSH 的一轮对话渲染成一段 prompt，付费路线用 `-p` 一次性交给 `zcode.cjs`（恒带 `--mode guarded`），免费路线经 app-server `session/send`。
- 把 ZCode 的输出帧按 DSH 的 `StreamChunk` 顺序投影（`block-start → delta* → block-end → usage → finish`），空输出与不可识别输出永不静默成功。
- 在**启动子进程之前**拒绝它兑现不了的请求：`tools`、`temperature`/`maxTokens`/非空 `stop`、`reject` 政策下的 image/file block，各配稳定错误码。
- 子进程环境是**闭集**：OS 基础变量白名单 + 五项契约值 + `passEnv`，宿主其他变量不外泄；`NODE_OPTIONS` 强制并入 ipv4-first DNS 修复，未知 flag 丢弃不透传。
- 设置页卡片读写插件自己的 loopback 路由 `GET`/`POST /plugins/dsh-zcode-provider/state`；「套餐」下拉自 2026-10-25 起是传输选择（免费＝app-server，付费＝`-p`），两者都是官方 CLI 子进程。

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

`tests/` 下 14 个 `*.test.mjs`；脚本里的显式清单、`docs/dsh-provider-contract.md` 的「测试面」计数与磁盘实点三者必须一致，否则门禁在跑测试前就停。用例总数同样锁死（171，`EXPECTED_TEST_CASES` 与文档「测试用例」行），删掉一个 `test()` 块也会让门禁变红。免费路线由一个实现了 app-server 协议的 fake CLI 端到端覆盖（流式/短答/resume/死会话/准入），浏览器半边字面量由 `tests/client.test.mjs` 逐项钉住。

## 已知限制（摘要）

- **工具隔离依赖 CLI 自身**：`toolPolicy: reject` 只拒绝下发 DSH 的工具 schema，关不掉 ZCode CLI 内部的工具能力；`--mode guarded` 下 CLI 内部工具行为**未验证**。本 provider **不宣称「工具已禁用」**。
- **prompt 在进程命令行可见**：`-p` 形态把整轮 prompt 放进 argv，同机其他进程可读。不要把凭据写进 prompt。
- **成功路径未实测**：账号返回 `1309`（套餐到期），`-p` 成功时的 stdout 形状、sessionId 获取、`guarded` 非交互行为、150% 计费均无读数（免费路线的 app-server sessionId 已可用）。
- **原子写仅单进程有效**：`sessions.json` 用带 `pid + uuid` 的临时名 + rename，无跨进程锁。

完整清单（L1–L10）见 `docs/dsh-provider-contract.md` 的「已知限制」。
