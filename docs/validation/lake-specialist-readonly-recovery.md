# 专员续办与数据库只读调查验证

日期：2026-11-05。功能提交 `403733cba0b51b2e10c4e361ed22440c797b9b40`；复现脚本提交 `088c8abdeb7649d3fca3362272188f9d92343527`。本批通过普通 PR 交付到 develop，不包含合并、生产安装或发布。

## 行为与范围

旧 SSH 未决操作仍保留原结果和写入保护。MySQL/PostgreSQL 的 `list_db_objects`、`db_table_ddl` 新增固定元数据读取通道：冻结连接和参数、5 秒期限、只读事务、结果和协议字节上限、结束回滚；目录最多 1000 行，达到上限明确标记截断。当前项目、数据库/schema、父权限和撤销继续检查；任意 SQL、其他驱动不自动获得只读证明。

暂停任务和运行中补充使用相同的重新检查提示：历史阻塞说明不能代替本次工具结果，相关只读检查与参数/别名修正应先自行尝试；不凭旧摘要要求用户找管理员。不改变原 Task/Worker、未知副作用、许可和验收账本。

## 本地检查

- Go 单元与协议回归：MySQL/PostgreSQL 原始许可、实际只读 BEGIN/回滚、绑定参数与标识符引用、固定搜索路径、未决记录保持、任意 SQL 仍受拦截，以及显式 schema 限制均通过。
- `go test -race ./internal/web -run 'TestSuper|TestSecurity|TestWork' -count=1 -timeout=15m`：通过，39.706 秒。
- `go vet ./internal/ai ./internal/web`、`python3 scripts/check_adk_runtime_boundary.py`、`python3 scripts/check_security_boundary.py`：通过。
- 集成 Dev 源码：`go test -race ./internal/ai ./internal/web -run 'TestSecurity(DatabaseMetadata|MySQLMetadata|Fixed|InspectHost)|TestSuper' -count=1 -timeout=15m`：通过，AI 67.523 秒、Web 22.117 秒。

`go test -race ./internal/ai -count=1 -timeout=20m`：完整通过，443.590 秒；运行期间 Go 源码保持稳定。第一次运行中，源码 AST 检查恰逢本地集成分支的临时合并冲突，因冲突标记失败；该次不计为通过，以上结果来自完整重跑。

## Lake Dev

使用 `scripts/build_lake_desktop.sh --dev --install` 签名构建安装。Dev 集成 SHA `5cd4eca6e3111c13635ce5396e36be952879a795`，构建时工作区干净；包含上述功能提交和先前已安装的 Dev 候选。独立集成分支不推送、不作为本 PR 的额外代码。

- 原生打开 `~/Applications/Lake Dev.app`，使用 `~/.lake-dev`；安装前通过“停止内核并退出”停止旧后端。重启后原项目、4 名专员及历史会话正常加载，运行进程与安装构建身份一致。
- 已签名安装包的后端执行 `scripts/verify_specialist_database_metadata_dev.py`：隔离 Home、合成 loopback provider 与 MySQL 协议服务，原任务先 blocked，用户补充后同一 Task/Worker 执行两次元数据读取，均 succeeded 并通过原验收。实际线上的两次只读事务均回滚，无操作审批弹窗；合成旧 SSH 仍为 unknown，原句柄不变。
- 日常 Dev 的消息、用户输入、操作、审批、路由决策和事件六张表，安装前后计数与完整行摘要一致。没有发送日常会话消息或修改真实远端资源。
- 机器证据：[安装与复现结果](lake-specialist-readonly-recovery-installed.json)。

## 验证限制与回退

复现 provider 是确定性脚本，验证宿主续办协议和工具执行链路，不是模型自主解题能力的实测保证。未执行真实 192.168.2.141 / K2 数据比较，未验证真实数据库版本组合，Docker 服务本机未启动；数据库协议夹具使用实际 Go 驱动。没有前端或原生 UI 改动，未宣称新的主题/窄窗口视觉验收。

不迁移或删除持久数据。回退通过 revert 本 PR；旧元数据操作恢复原不透明通道及保护。已登记证据、许可、原未决操作保持原样，不能因回退或清理聊天把未知写入当作已结清。
