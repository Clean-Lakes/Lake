# Lake TS Agent v0.0.1 验证记录

日期：2026-10-08。分支：`codex/lake-ts-agent-v0.0.1`。发布门禁通过的本地候选版本，未推送；外部 provider 和生产环境未执行验收。

Agent 循环、历史、上下文、预算、专员工单、共享终端和持久运维执行为本分支新实现。运行时不导入旧 Lake/ZCode/Tianshu Agent 内核。

## 环境与分发

- macOS arm64，Apple M5，10 CPU，24 GiB；Node 24.14.0（官方归档 SHA256 已核对），pnpm 10.33.4。
- Docker Desktop 29.1.5；真实 PostgreSQL 16，kubectl 1.34.1 调用受控 API 夹具；Linux/systemd 目标为虚拟化内一次性 PID 1 systemd 容器。
- macOS launcher、Node、fs-ext 原生模块均使用 `Lake Local Development Code Signing`，逐一验签。入口只由 `scripts/build_lake.sh` 构建。
- 当前 macOS runtime 摘要：`90390c2f9663b275b301717b3c1bd18040ac23d3b0ff36645619581b5f3d9a8f`。
- Linux amd64 在 Apple Silicon 的 amd64 仿真容器编译 Node 目标的核心和原生依赖；复用可移植的完整 Vite JS/CSS 构建结果。仿真中直接 Vite 构建曾因 esbuild 崩溃失败，此路径已明确记录。
- Linux runtime 摘要：`0d0a3039cd1516462d00d48cb96210e83d0be7a1470fe39caecd7de697603406`；归档为 `bin/lake-agent-0.0.1-linux-x64.tar.gz`。
- 两个平台均将分发复制到无源码目录，在仅系统工具 PATH 下启动 CLI、唯一 daemon、API 和 Web，加载内置技能与 fs-ext 通过。
- pnpm 锁文件 SHA256：`6912b7d2f0b537bf23c949bec28179f258fc427e0b3ff51de72ed70b317518bf`。

## 自动验收

| 门禁 | 结果 | 实际覆盖 |
|---|---|---|
| 严格类型与模块边界 | 通过 | 核心/UI typecheck，纯 domain、禁止旧 Agent/框架导入；越层依赖曾被检查拦截并修正 |
| 单元测试 | 5/5 | 领域输入、模型配置、六技能快照、关键状态边、成功必须有证据 |
| 集成测试 | 44/44 | SQLite FK/CAS/事务回滚/WAL 备份；进程锁竞争与 SIGKILL 释放；事件 cursor/重复/缺口；预算共享、价格来源、上下文压缩/恢复、模型重试/取消/半流 |
| 运维与权限集成 | 包含于 44 项 | 真 SSH exec/PTY/指纹，真实 PG 固定只读查询，真实 kubectl/API；授权撤销、审批行动 ID 单次绑定、终端多读单写、人工租约、接替步骤、凭据与跨块 PEM 脱敏、只读容器快照 |
| 业务验收 | 9/9 | Linux 服务恢复、配置替换、备份权限、健康失败回滚、外部漂移拒绝；三专员共用终端/进度；三个 SIGKILL 点；CLI/API ID 与等待退出码一致；签名入口 |
| 独立分发 | 通过 | macOS/Linux 运行时、原生模块、API/Web 在源码目录外启动 |

TEST-001～009 的证据对应 contracts/state-machines/daemon-lock/storage/event-replay/credentials/artifacts/budgets；TEST-010～018 对应 model-protocol、agent-loop、runtime-recovery、runtime-guards、context-compaction、skills、specialist-scheduler/inbox/cancellation；TEST-019～035 对应 authorization、execution-sessions、terminal-concurrency/redaction、handoff、workspace、SSH/K8s/PG/HTTP、approval/action-runner、verification/business-proof/delivery/service-context；TEST-036～040、042～043 对应 acceptance 套件与 verify-release。部分行为规格合并到同一测试文件，不按文件数量伪造覆盖。

真实协议使用合成凭据和固定 HTTP 模型，未读取用户模型 key、SSH 私钥、Keychain 或生产数据库。未知写效果核对前不重派；回滚成功仍保持原变更失败。外部模型 smoke 为 `not_run`，这不是任意兼容 provider 都已验证的声明。

## 浏览器人工验收（TEST-041）

使用 Codex In-app Browser，2026-10-08，真实 localhost 工作台和隔离 Linux 目标：

1. 从空界面选择环境、资源和配置变更类型，新建会话；专员使用真实 SSH/SFTP 生成变更。
2. 查看冻结目标、旧指纹、新配置内容与摘要后审批；等待 HTTP 连续成功，步骤和报告完成。
3. 接管 SSH PTY，发送 `printf` 测试标记；输出写入共享历史并显示。确认停止后交还，持有者清空，epoch 更新。
4. 刷新通过 HttpOnly cookie 重连，保留任务、报告、终端历史；新页面不会自动取得旧输入租约。
5. 主会话追加约束并广播，恢复后由三位专员完成共享步骤；另一个浏览器读者观察相同会话与输出。
6. 最新源码的无凭据 HTTP 演示再次显示三位专员、一个会话终端、三个已验证步骤。截图已留存。

![三专员与共享终端](lake-ts-agent-workbench.jpg)

## 性能

macOS 实测 600.3 秒、2000 个业务事件、10 MiB 终端输出、3 active specialists/2 model requests；1000 个快照与1000 个活动样本：snapshot p95 3.20 ms、活动更新 p95 240 ms、峰值 RSS 201.64 MiB。测试是本地投影负载，不把外部模型延迟、生产服务容量或数据库大规模历史算作已验证。

4 CPU/8 GiB Linux amd64 仿真基准完成 600.3 秒，2000 个业务事件、10 MiB 输出、1000 个快照与1000 个活动样本；snapshot p95 21.78 ms、活动更新 p95 260 ms、峰值 RSS 377.54 MiB。CPU 配额为 `400000/100000`，内存上限 `8589934592` 字节。RSS 使用 `/proc/self/status` 的 VmRSS；仿真中 Node 返回 0 的旧测量已作废，收集脚本拒绝零/不可用值。所有性能阈值通过。

## 明确边界

首版 K8s、PostgreSQL 只读；自动变更仅登记的 Linux 配置/systemd 模板和受控本地 patch。专用 VM 断电、生产宿主机、真实 K8s 集群、远端真实模型、跨主机发布和数据库写未验收。没有任意插件宿主、桌面安装包或定时自治。未知输出的任意恶意编码不是完整信息流隔离保证。

原有插件未跟踪目录、旧 Electron 客户端和用户旧数据未改写或自动迁移。正式工作与凭据需要按运行说明显式配置。
