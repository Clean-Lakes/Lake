## TS/ZCode Super-agent 增量

2026-11-05，基于 develop `16ef70750bf63a9fc6b800ce6cac674c7194257e` 和固定 ZCode v3.17.2。用户要求迁移最新 Super-agent；此前已明确授权覆盖 TS/ZCode Dev。完整功能迁移要求保持，普通默认/正式构建门禁不变。

实现了真实 Pilot 元数据/路由、稳定专员与连续频道、独立 Worker/ZCode 执行会话、原任务/尝试/操作/验收记录、Plan 确认与只读约束、原权限开关、停止/租约/重启失效、只读失败的新诊断尝试、报告 outbox，以及只读旧目录与历史迁移。Router 无资源执行工具，未接通的工具不伪装成能力。

## 本地验证

以下命令使用固定 Node 24.14.0：

```sh
node third_party/zcode/node_modules/typescript/bin/tsc -p runtime/zcode/tsconfig.json
node runtime/zcode/build.mjs
node --test runtime/zcode/server.test.cjs
```

24/24 集成测试通过。测试经真实 ZCode AgentRuntime、Node filesystem、官方公开 SessionStore port 与本地 HTTP 模型夹具：

- 真实 Pilot 创建/列出专员、创建独立 Worker、读取本项目工作区、按本次工具结果验收与报告；重启身份/频道保留。
- 纯专员元数据管理不创建 Goal 或 Worker 执行会话；删除范围、CAS、幂等与历史保留。
- 待批准 Write 停止后不派发、旧批准失效；权限改变后原批准不能派发。
- 普通任务自动注册；Plan 先确认，工具目录没有 Write/Edit/Bash；拒绝或重启后不恢复旧确认。
- 伪造回执和 Worker 成功文字不能关闭任务；摘要 revision/hash 与跨项目读取被核验。
- 当前读写审批开关进入 Worker 的会话级规则；ZCode 首次输入写入不会覆盖 Lake 的真实项目身份/规则。
- 真实只读失败保留失败操作，原 Goal 创建 retryOf 尝试并取得新观测；不重置期限或轮数，不重放写入。
- Go 项目、专员、频道和历史 Worker 身份保留；精确已提交 ADK artifact 优于旧缓存和更高的孤儿版本；351 张历史卡片按 300 张分页，频道 keyset 无重叠。
- 原数据库 SHA 不变；回退拒绝已修改数据/新任务，只删除未改变的本批导入及派生视图。
- 已有 Home gate 关闭后审批失效，进程内重新打开不复活原批准；明确原项目策略不会被通用 allow 替换。

现有 Dev 的目录与 ADK/AI 历史通过 APFS 写时复制创建独立演练副本，未复制 secrets，也未调用真实供应商。演练导入 **5 项目、82 会话、144 资源条目、8 专员、22 历史 Worker**，成功读取 15 个历史视图；新增 Worker/资源操作均为 0。旧资源除新 TS 工作区外作为不可用元数据保留，未连接或执行远端。

另外通过 Web 类型检查、603/603 前端测试与 Web 构建，16/16 `test_dev_*py` 和 ADK runtime boundary 检查；桌面脚本 `sh -n` 通过。全量 parity 检查按预期退出 1（118 操作、20 领域均尚未完整 verified），没有取消该门禁。

## 尚未等价迁移

本批不是全量 Super-agent/后端等价验收。Worker 当前仅有本项目工作区文件适配；终端/SSH/服务、MCP/Skills、外部守候、跨旧任务的执行证据授权、完整 Security/grants/对账、附件、队列/上下文编辑、工作流/日程、Memory、CLI/Magpie 和 Windows 仍有缺口。旧会话/任务只读，旧远程资源不可执行；明确原项目策略需要后续适配，不能因迁移清除原限制。关闭或未知的安全状态保留查看能力，不执行后台模型或资源操作。

`parity.json` 对相关领域只标记 partial；全量门禁必须继续失败。本批未验证真实供应商、SSH/数据库/集群、Windows、完整 Go/race/vet 或全部恢复场景，不能将夹具成功写成这些场景通过。

## 签名 Dev 实测

已从干净源码 `52f7ff1ff57dae90c7ef1d85080d4169dafa3686` 执行 `scripts/build_lake_desktop.sh --dev --ts-candidate --install`，覆盖 `~/Applications/Lake Dev.app`。签名验证及 ZIP/DMG SHA-256 通过，原生 LakeUpdateTests 通过（下载进度/取消、Dev 隔离、更新状态/清理与发布策略）。包内后端 SHA-256：`bf6f374a4a46cc6f487a4beb534e539f65f5bcdb481aa3e82dac5177f9e51a68`。

原生窗口实际显示 **Lake Dev · TS/ZCode**；页面实际显示 **Pilot、4 个未删除的现有专员、资源目录与旧 Pilot 历史**，不再是空欢迎页。未发送消息或调用真实供应商/远程服务。认证 bootstrap 为 `backendRuntime=typescript`、`aiRuntime=zcode`、`upstreamVersion=3.17.2`、`recoveryReadOnly=false`；lifecycle 的运行 PID、Home 和 data 与 Dev 运行记录匹配。

真实迁入 5 项目、82 会话、8 专员（4 个未删除）、22 历史 Worker；TS 新 Worker/Goal/资源操作均为 0。原 Go Web 数据库、ADK 数据库、providers.json 与 Security control 的字节摘要均与停止后的备份一致。迁移前已正常停止旧 Dev，并将旧 Dev 应用和 Home 作 APFS 私有备份，路径保存在本机 `/tmp/lake-super-dev-backup-location`；原 Go Dev 的更早备份也保留。

持续终端适配未完成，因此顶部“服务端不支持持续终端”的提示仍显示，没有删除提示或伪报 `terminalMode=pty`。实机未执行深色/窄窗全量等价验收，不能将这次原生启动算作相关领域 verified。
