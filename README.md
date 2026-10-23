# dsh-zcode-provider

DSH 的 ZCode provider：把本机 `zcode.cjs`（ZCode 0.17.0）作为一个 `zcode` 路由接进 DSH 的 LLM 层。一个 `LlmAdapter`，无运行时依赖（`dependencies` 为空），Node ≥ 22。

## 它做什么

- 把 DSH 的一轮对话渲染成一整段 prompt，用 `-p` 一次性交给 `zcode.cjs`，恒带 `--mode guarded`。
- 把 ZCode 的 NDJSON 帧（`text_delta`、`usage`、`session`、`finish`、`error`）按 DSH 的 `StreamChunk` 顺序投影出来。
- 在**启动子进程之前**用稳定错误码拒绝它兑现不了的请求：`tools`（`reject` / `dsh-owned` 下）、`temperature` / `maxTokens` / 非空 `stop`、`reject` 下的 image/file block。
- fail-closed 的宿主校验：四项 ZCode 路径变量、`NODE_OPTIONS` 值级白名单、会话 workspace 根（拿不到报 `WORKSPACE_UNAVAILABLE`，不退回 `process.cwd()`）。
- 子进程环境是**闭集**：只有固定白名单 + 五项契约值 + `config.passEnv`，宿主其他变量不外泄。

不做什么：不做模型发现（ZCode 没有免配额的模型列表）、不猜计费、不判套餐权益、不伪造 sessionId。

## 安装

1. `pwsh -File scripts/install-env.ps1` 看 dry-run，确认后 `pwsh -File scripts/install-env.ps1 -Apply`（已存在且不同的变量默认跳过，需 `-Force` 覆盖）。
2. 在 profile 的 `package.json` `dependencies` 与 `cordis.patch.yml` 里加本包条目（改前备份）。
3. 重启 DSH。

细节、契约表与实测基线见 [`docs/dsh-provider-contract.md`](docs/dsh-provider-contract.md)。

## 门禁

```bash
node scripts/run-tests.mjs    # AC11 行尾 → tsc --noEmit → build → 包入口点 → 测试面计数 → node --test
```

`tests/` 下 8 个 `*.test.mjs`；脚本里的显式清单、`docs/dsh-provider-contract.md` 的「测试面」计数与磁盘实点三者必须一致，否则门禁在跑测试前就停。

## 已知限制（摘要）

- **工具隔离依赖 CLI 自身**：`toolPolicy: reject` 只拒绝下发 DSH 的工具 schema，关不掉 ZCode CLI 内部的工具能力；`--mode guarded` 下 CLI 内部工具行为**未验证**。本 provider **不宣称「工具已禁用」**。
- **prompt 在进程命令行可见**：`-p` 形态把整轮 prompt 放进 argv，同机其他进程可读。不要把凭据写进 prompt。
- **成功路径未实测**：账号返回 `1309`（套餐到期），`-p` 成功时的 stdout 形状、sessionId 获取、`guarded` 非交互行为、150% 计费均无读数。
- **原子写仅单进程有效**：`sessions.json` 用带 `pid + uuid` 的临时名 + rename，无跨进程锁。

完整清单（L1–L10）见 `docs/dsh-provider-contract.md` 的「已知限制」。
