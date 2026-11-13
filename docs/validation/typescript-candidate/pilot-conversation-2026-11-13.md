# Pilot 多干员对话验收

日期：2026-11-13。最终运行源码 tested SHA：`e06102804a80bb4bb6cb54710b1667af263d4a4d`；首轮真实模型与界面截图源码为 `b86261464d5cbf806e7cf8e439fa32349c076320`。后续提交只修正取消期间的状态竞争、动态共享容量及对应回归，没有修改 UI。

## 行为与边界

`convene_specialists` 使用当前 Pilot 人工事件、准确原文和稳定 part_key 建立对话轮次。全部模式冻结完整项目目录，指定模式使用准确 RoleID；角色职责版本和收件人独立 Session 随轮次保存。专员自己的完整成功回复才会产生署名回应，发到原 Pilot 对话及专员频道。宿主持久追踪尚未回应、失败、超时、取消和中断，全部收件人结清后另行唤起 Pilot 汇总。

对话不产生业务 Goal、Operation 或验收回执；成员及汇总模型没有业务工具、子智能体或长期 Memory 注入。业务任务原来的证据验收不变。停止后不接受迟到结果；跨多个轮次停止时重新读取当前记录，保留期间已经收到的真实回复。SDK 初始化异步返回后重新检查成员状态和全局/项目剩余容量，不能重新唤醒已取消者或超出共享并发。

同 event/part 幂等；重启只保留已有回应并把未结轮次标为中断，不重放模型。默认等待 120 秒，参数可选 15～300 秒；Pilot 汇总独立等待 120 秒。每轮最多 64 位干员，项目最多 4 个未结轮次，执行与原业务 Worker 共享全局 4、项目 2 的容量。

## 自动验证

使用仓库固定 Node.js 24.14.0；以下命令执行前将 `third_party/.lake-cache/node-v24.14.0-darwin-arm64/bin` 放到 PATH 首位。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| TS 类型 | `node third_party/agent-sdk/node_modules/typescript/bin/tsc -p runtime/typescript/tsconfig.json` | 通过 |
| TS 源码全量 | `web-agent/node_modules/.bin/tsx --tsconfig runtime/typescript/tsconfig.json --test runtime/typescript/*.test.ts` | 269 项，265 通过，4 条件跳过（可选 Claude-Mem 与 Linux 平台场景） |
| 新对话生命周期 | 上项包含 `specialist-conversations.test.ts` | 12 项通过：真实回复、独立上下文、幂等、无回应、模型失败、排队与执行超时、汇总超时、停止、重启、跨项目/角色/权限、取消竞争和动态容量 |
| 原宿主生命周期 | 上项包含 `superagent-lifecycle.test.ts` | 68 项通过，包括新的召集/回复/汇总和 Pilot 停止集成 |
| 真实 SDK/HTTP 全量 | `node --test runtime/typescript/*.test.cjs` | 211 项通过；包含 6 人真实 SDK 对话、单人模型失败、HTTP 停止及原业务集成 |
| 前端全量 | `pnpm --dir web-agent test:frontend` | 776 项通过，0 跳过 |
| 前端类型与构建 | `pnpm --dir web-agent build:web` | 通过；保留已有大 chunk 提示 |
| 架构边界 | `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| 签名独立后端 | `scripts/build_lake.sh --typescript`；`codesign --verify --strict bin/lake` | 从干净 detached 工作树构建，通过 |

最终签名二进制 SHA-256：`62cac783c398226053c27f7ee0f4a1ce21b0da9a5ca092c56665f6cfa20d76ab`。

## 真实模型与界面

使用 Dev 已配置的 `codex/gpt-6.1-sol`，签名后端运行在随机 loopback 端口和独立临时 Home。仅在该临时 Home 中配置当前选定的 Dev 模型及六位角色的元数据；没有导入业务任务、资源连接、权限、Memory 或正式版数据。凭据使用私有文件，未写入记录、截图或仓库。

原样输入“全部干员给我报数！”：Pilot 实际调用召集工具，六位干员各有独立 SDK Session，分别返回自己的报到文字；每条消息带对应 RoleID、执行会话和召集来源。最后由独立 Pilot 模型读取六条真实回应汇总“6/6 人回应，无缺席”。新增业务 Goal、Operation、验收回执均为 0。真实模型按实际完成顺序到达，报到编号不强制决定消息显示顺序。

首轮实际回应、模型、时间、会话与最终摘要保存在 [首轮模型证据](pilot-conversation/real-model.json)。最终源码重复发起新的同文召集，见 [最终模型证据](pilot-conversation/real-model-final.json)；六位均取得新的独立回应，不复用上一轮回应作为新报到。

Ego Browser 对实际服务页面检查：浅色处理中能看到逐人等待状态；完成后六种作者身份和 Pilot 汇总独立显示，发送入口恢复可用。深色宽窗同样可读；390px emulation 的 document/viewport 宽度相等。原生安装与完整窄窗目视限制见下节。

- [浅色召集中](pilot-conversation/light-progress.png)
- [浅色完成](pilot-conversation/light-completed.png)
- [深色完成](pilot-conversation/dark-completed.png)

## 安装限制与未验证项

尝试标准 `scripts/build_lake_desktop.sh --dev --install` 时，来源保护发现已安装 Lake Dev 包含未合入的 ACP 分支提交 `71af70b8441d…`，其来源为独立 `acp-agent-execution` 工作树。本次从 `origin/develop` 开始的代码不包含该基线，因此脚本正确拒绝覆盖。没有关闭检查、混入其他分支、修改正式版安装或覆盖用户 Dev 数据。

现有原生 Lake Dev 已重新打开，原项目、专员与可用输入框保留。本次采用 CONTRIBUTING 允许的独立 Home/端口签名 Web 联调完成模型与界面验证。未把这一结果记为已安装原生应用验收；原生组合安装、关闭导航后的完整窄窗目视、Windows/Linux 平台实测仍待完成。没有触发 CI、合并 PR 或发布。

## 回退

回退本功能源码即可停止产生新召集。保留已写入的对话轮次、执行索引和公开消息；旧任务、Operation、未知效果、Memory 和验收记录不改写。临时验证后端停止后清理临时 Home 及其模型凭据；保留上述脱敏证据。
