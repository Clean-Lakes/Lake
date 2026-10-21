# P7 在线只读纠错验证

最初从 develop `74c242c06142861ac7808e0466671dacb2023ce5`（PR #50）开始；提交前同步到 `beb79736ff42504f933a16f9d31acd4f9cdce896`（含 PR #47/#51），工作分支 `codex/strategy-learning-p7`。新增进度摘要额度门禁，并复验新版执行记录/确认恢复的兼容性。仅使用本地 `gh bearqy` 提交 develop PR，不合并、不触发 CI、不发布或操作生产。

## 本地检查

专项覆盖：官方 ADK 的超时→提案→独立采样→报告、保留旧 unknown、无提案/错误来源/重复 JSON 键、拒绝 SQL/MCP/写入/换目标、权限/范围/能力分类、预算/无进展、关闭与 epoch 撤销、角色共享并发、未知 usage、崩溃恢复、显式继续与等待 TTL，以及原缺口不因另一检查成功而消失。SRE 集成测试复用真实本机命令执行，比较原行为与显式开启 P7 的父任务提案/观察/用量记录。

最终源码与签名 Dev 提交为 `e21a9c33ff41f5cedca6b0323b4b17ed779261e0`（dirty=false）；其源码树与整合检查的 `fae3e221` 完全相同，另保留先前已验证 Dev 的祖先，遵守安装来源校验。后续提交只补本文、JSON 记录和计划完成标记。

| 检查 | 结果 |
| --- | --- |
| `go test ./internal/ai ./internal/web ./internal/strategy` | 通过；AI 38.654s，Web 130.472s，strategy 缓存通过 |
| `go test -race ./internal/ai ./internal/web ./internal/strategy` | 最终完整回归通过；AI 122.075s，Web 318.400s，strategy 缓存通过 |
| `go vet ./internal/ai ./internal/web ./internal/strategy` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | production entrypoints/provider-call AST 检查通过 |
| `corepack pnpm test:frontend` | 最新 develop 上 386 项通过，无失败/跳过 |
| `corepack pnpm build:web` | 类型检查与 Vite 构建通过；既有大 bundle 提示保留 |
| macOS 签名 | 标准 Dev 构建/安装成功；Dev app 和 bin/lake 的 codesign strict 验证通过 |

早期同时运行构建、完整 Go 和 race 时，既有 100ms 手动压缩可见性及 P6 撤源用量断言各出现一次时序失败；分别单独重复 3 次通过，最终整合版完整 race 通过。未放宽断言、删除测试或绕过门禁。

## Lake Dev

使用 Node 24、项目固定 pnpm 10.33.4 在 web-agent 中先完成前端构建，再通过 `LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake_desktop.sh --dev --install` 打包同一批新产物；未跳过构建或签名。系统全局 pnpm 为另一版本，因此没有绕过项目版本检查。每次替换前正常退出 Dev，不操作正式版。

最终独立 Home 为 `/var/folders/vd/tpn95_y535g6h9b4fkgmlc380000gn/T/lake-p7-ui-xordy3i4`，不使用正式版配置或凭据。仅配置无密钥 loopback 模型夹具，并关闭无关的记忆提取/学习；同一人工确认的 v1 资产分别应用到两次普通 ADK 任务。执行器通过真实本机终端和受信 policy 执行 curl，健康端点第一次主动断连、第二次返回固定真实响应，不伪造工具结果。

| 模式 | 实际健康 GET | 主任务模型请求 | 实际结果 |
| --- | --- | --- | --- |
| 在线关闭 | 1 | 2 | curl exit 52，保留失败，无修订工具或纠错记录 |
| 在线开启 | 2 | 4 | 原 failed 调用保留；提案后独立 succeeded 调用取得 healthy=true |

开启记录包含 1/2 次修订、1 次真实缺口关闭、0 项未闭合检查、3/12 次纠错阶段请求、600/100000 token、4 个实际 manifest 引用，采用的资产仍是同一 v1。纠错阶段计量包含最终报告，不是相对关闭场景的净增请求数。没有后台记忆、命名或 UI 模型摘要混入这六次主请求。

Dev 实测发现并修复了 SQLite int64 退出码被当作零的问题，并增加真实返回类型回归；也修复项目尚未保存时继承在线开关的展示遗漏，保留项目原 scope/revision/epoch。SRE 专项另外保留原 unknown 只读超时记录，以新的调用执行真实本机采样，父任务共享提案和预算。

最终 UI 验证了新版执行区域按资源归并、纠错卡不被收起丢失、失败来源/证据 hash/版本/提案可查看、浅色和深色、850×600 窗口及长 hash 换行。独立开关与全局继承实际状态一致；共享 AppSelect 的菜单、Escape 焦点、圆角与裁切通过检查。恢复浅色和原窗口后正常退出 Dev。

用同一签名 bin/lake 重启该 Home：完整纠错报告、3 次请求和 600 token 不变，源调用仍 failed，新采样仍 succeeded，重复快照/空闲期间没有增加操作；原资产版本保留。Web/native SQLite integrity_check 均为 ok。测试服务正常退出，无第二个后端争用 Home。机器可读结果见 [P7 验证 JSON](lake-strategy-learning-p7.json)。

## 边界

模拟模型只用于可重复控制流验证，不证明真实模型的纠错收益。Windows/Linux、付费模型、代表任务三次以上配对样本和推广门槛属于后续验收。设计与回退见 [P7 设计](../design/strategy-learning-online-v1.md)。
