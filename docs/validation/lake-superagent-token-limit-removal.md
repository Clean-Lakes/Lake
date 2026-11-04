# 取消 Super-agent 累计 token 上限

2026-11-03，用户明确要求去掉此前解释的单任务累计 token 上限。被测源码与干净签名 Dev 安装来源均为 **`947e2f1171577a11b548557323e29dab9d2c1804`**；后续只补充本记录和 PR 说明。机器可读结果见 [JSON](lake-superagent-token-limit-removal.json)。

## 最终策略

- Super-agent 主任务与可信子专员的累计 token 只用于记账，不再以 128K/256K 等累计总量或剩余额度拒绝模型调用。新活动任务的 `TokenLimit=0` 表示无累计 token 上限；旧活动任务的正数限制转为 0，已结束历史任务无需改写。
- 每次调用仍记录预留，返回已知用量后幂等结算；未知用量保持保守记账。历史 Tokens、Rounds 和原请求记录不清零，子专员沿用原任务计数，也不叠加旧 Scout/Beacon/SRE 的另一层累计 token 熔断。
- 模型单次上下文/输出限制、累计调用轮数、绝对期限、并发、子实例数量、租约、当前 Security、资源范围和独立验收均保留。普通旧观察器的原额度行为不受这项 Super-agent 策略调整影响，Memory 实验及后台门控不变。
- 仅由旧 token 限制造成的暂停，解除该标记并保留原任务等待后续核对；不标为成功、不签发新许可、不重放已消费消息或原操作。主动暂停、轮数用完和期限已到继续保留各自状态。原始错误与暂停通知属于历史，保留；当前正文和最新 Pilot 通知明确显示“累计 token 上限已取消”。

本次取代 [此前累计额度暂停阶段](lake-worker-budget-pause.md) 的 token 熔断策略，架构约定与实施方案已同步用户最新要求；整体 Super-agent 计划仍为 In progress。

## 验证

| 检查 | 结果 |
| --- | --- |
| `go test ./... -json -count=1 -timeout=12m` | 1,954 项测试/子测试、11 个包通过 |
| `go test -race ./internal/ai ./internal/security -run 'TestSuper\|TestWork\|TestAgentBudget\|TestAgentCumulative\|TestSecurityInspectHost' -json -count=1 -timeout=6m` | 106 项、2 个包通过 |
| `go vet ./...`、ADK runtime boundary | 通过 |
| `pnpm --dir web-agent check`、`test:frontend` | 类型检查、574 项测试通过 |
| `scripts/build_lake_desktop.sh --dev --install` | 干净上述 SHA 构建安装成功，应用与后端严格签名验证通过 |
| 原生及浏览器界面 | 当前任务不再显示 token 额度暂停；浅色 1280px、深色 600px 各一条取消说明，无横向溢出，编辑器可键盘聚焦 |

新增及调整回归实际验证：累计 Tokens 已超过旧 256K 时，仍允许新的大额预留，并按实际用量结算且不重复结算；可信 Super-agent 子专员不被另一层旧累计 token 上限拦截；普通旧观察器限制仍有效。旧 token 暂停解除时不增加 Worker generation、不清零计数，重复监督只生成一条取消通知。已用完轮数、用户主动暂停或已到期限的任务不会被这项调整恢复；期限、资源绑定与验收仍独立成立。

首轮定向回归暴露了测试夹具默认只允许一轮的问题；场景已显式设置保留的 500 轮条件，随后完整回归通过，没有删除轮数检查来通过测试。

## 真实 Lake Dev

使用固定 `~/.lake-dev`、Dev Bundle `com.cleanlakes.lake.desktop.dev`，仅正常停止并更新 `~/Applications/Lake Dev.app`。安装后端 SHA-256 为 `7935d548cfd879e07ccf466387d4c3b4681df4018c243586c5b91e30fe2f1828`。既有 Web 大 chunk 和 Swift 参数弃用警告仍不阻断构建。

原任务当前 `TokenLimit` 从 256,000 转为 0，Tokens 仍为 **236,780**、Rounds 仍为 **13**，Assignment 仍为 parked/generation **3**，原因标记为 `token_limit_removed`。该任务解除额度暂停后仍保留待核实状态；原先已确认的空资源范围没有被追加，不能把取消额度上限当作服务器检查已成功。新的取消通知只投递一条。

更新前后的绝对期限、轮数上限、资源绑定相同；93 条历史 legacy unknown 的 `id/session_id/tool/risk/status/handle/result` 排序投影 SHA-256 均为 `9540501386ee5c60b1d27425ad0ccabb52d6718a4d64a3973b65e703e8409cd5`。侧栏恢复原项目的 135 个资源。没有新增真实模型执行代数或远端巡检，没有验收代签或生产变更。

原始日志、测量与截图仅保存在本机 `/tmp/lake-uncapped-*`，可能被系统清理；没有提交真实项目截图、连接配置或令牌。PR #142 继续指向 develop，尚未获得本次合并授权。

## 数据与回退

无新增列或表，不清理任何历史操作或用量。`TokenLimit=0` 的语义已调整为累计记账不封顶；旧内核可能把 0 当作已耗尽额度，因此不直接降级解释当前活动任务。需要恢复累计限制时，通过后续 PR 显式恢复策略及正数限制后再验证，仍保留既有计数和风险记录；不降低 Security 迁移格式兼容门槛。
