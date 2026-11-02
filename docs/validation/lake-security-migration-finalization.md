# Lake Security 单库迁移收尾验证

2026-11-03，macOS arm64。用户授权完成日常 Lake Dev 的迁移收尾及清理。实现和签名安装源码为干净提交 `c42c96f289874771cd9f77786d5418ccdbefc45f`，后端 SHA-256 为 `db4bb410eeca90d80388a0509edbe9abcd6a2d8ef9ba6f6847359c2eb06ab2b5`。机器记录见 [JSON](lake-security-migration-finalization.json)。

## 收尾协议

新增离线 `lake security finalize-migration --home PATH`，默认只检查；`--apply` 才提交并清理。仅支持 gate open、StoreReady、没有恢复流程的一份规范库初始迁移档案。原 Home/DataDir/server owner 锁保持有效，运行中的实际 Dev 也已验证拒绝收尾。独立 stdio/双库、待审迁移、关闭 gate 和恢复激活档案不适用。

对原快照做完整摘要校验，再在一致只读事务中逐主键比较所有历史记录和不可变内容。会话当前状态、操作结果、工作目标进展等明确可变字段由当前账本负责；事件、证据和版本化制品必须完整保留。旧未决结果不得因清理自动变成已结清。操作身份摘要从原始快照生成，并在规范库提交事务内再次匹配。

完成凭据先写入规范 SQLite 的应用元数据表 `security_legacy_finalizations`，再原子发布 format 2、state finalized 的清单，最后只删除准确匹配的迁移副本。模拟在 receipt、inventory、removed 三个阶段中断，均能安全启动和幂等续跑。正常启动验证小凭据及旧操作身份，退出的快照不再作为启动条件；离线风险核查继续读取当前账本。

凭据不保存另一份操作状态，不签发授权或结清结果。旧未决调用不能换 ID 重放，新的独立调用仍走原规则。受支持的旧 reader 会拒绝 format 2；回退必须保留该 reader 支持，不能在副本删除后手工降清单为 v1，也不能用旧备份覆盖当前账本。配对恢复、epoch、原操作/证据、权限与 Memory 门控不变。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `go test -json ./... -count=1 -timeout=15m` | 1,943 项、11 个包通过 |
| Security / Super-agent / Recovery / Replay 定向 race | 494 项、3 个包通过；完整命令见 JSON |
| `go vet ./...`、ADK 边界 | 通过 |
| 签名桌面构建安装 | Node 24.14.0、pnpm 10.33.4，`scripts/build_lake_desktop.sh --dev --install` 通过 |
| 应用与后端严格签名 | 通过 |
| 单测保护 | 只读预检、owner、篡改/丢失、身份/epoch、晚到旧库、未决状态、取消、中断续跑、凭据损坏及原调用防重通过 |

前端源码没有变化，未重跑前端测试套件；之前的前端结果仍属于原 SHA。Windows 原生启动、物理断电、新外部模型任务和完整旧二进制降级执行未测。

## 日常 Dev 的实际结果

预检确认 13 张旧表中全部历史仍在当前库，包括 530 个会话、22,253 条事件、2,459 条操作、5,019 条证据和 8,026 个制品版本。原快照为 `~/.lake-dev/security/initial-migration-recovery/sessions.sqlite`，3,799,941,120 字节（3.539 GiB）。

正常停止 Dev 后，使用签名新二进制依次执行预检、`--apply`、重复 `--apply` 和 `security risks`。原文件已删除；第二次应用返回 removedBytes 0。完成凭据为 330,199 字节。当前 2,542 条操作的完整逐行摘要在清理及重启前后完全一致，93 条 unknown 仍保留；control 文件摘要及 epoch 未变。没有删除当前操作、证据、会话、Memory 或其他恢复备份。

当前库仍有 588 个 SDK 会话、23,161 条事件、5,285 条证据和 8,291 个制品版本；Web 库仍有 6 个项目、70 个会话、142 项资源和 874 条消息。可见目录按原规则过滤后为 5 个项目、139 项资源，不能直接与包含已删除/隐藏行的数据库总数比较；最初验证脚本误用了该口径，已改为数据库前后同口径核对，记录没有减少。Pilot snapshot 仍恢复 Go、前端与本机专员的原始回复身份。

一次冷启动观察到后端进程后至鉴权 HTTP 就绪为 759.6ms，原生进程至该端点就绪为 1,208.3ms。此前旧内核的 runtime 发布观察为约 3,041.7 / 3,357.2ms。新旧端点略有差别，该记录是本机启动阶段观察，不代表 UI 首帧或统计 p95。原生 Dev 工作台实际打开，原专员、灰色回复气泡、资源及默认收起的详情可见。

原始日志仅保留执行环境 `/tmp/lake-migration-finalize-*`，路径见 JSON，系统清理后可能消失。没有向公开 PR 上传客户端截图、用户消息或数据库。没有合并 PR、发布或访问/重启正式版 Lake。
