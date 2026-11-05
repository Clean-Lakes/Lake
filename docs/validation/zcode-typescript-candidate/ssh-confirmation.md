## SSH 与确认入口增量

2026-11-05。用户报告侧栏“需确认”却没有确认内容、原可用服务器被报告为 SSH unavailable，以及资源列表不能新建 SSH 终端。

### 原因与行为

- 侧栏将普通任务 `waiting_user` 当作确认来源，即使频道没有待批操作或问题也显示“需确认”。带频道元数据时改用实际 needsConfirmation，来源为当前 Worker 的审批、问题或 SSH 指纹提示；保留旧无频道协议的展示兼容。未完成但没有实际问题的 Worker 结束为 paused，不伪造需回答状态。
- 旧目录 v1 迁移只保留资源元数据，没有迁入 resourceConnections 的 SSH 配置，并保守标记 unavailable。新批次只对仍未配置、已有 v1 来源记录的 SSH 资源增量恢复确切配置与 Dev 私有文件引用；验证所有权、权限、同 Home、文件类型和链接边界。保留 v1 不可变收据，不覆盖 TS 编辑，不写原 Go 数据，也不连接服务器或重放任务。
- 使用固定上游依赖 ssh2 1.17.0 公开接口实现 SSH transport；原 `ssh-host-<peer hash>.known_hosts` 可直接复用，优先已保存公钥算法，避免无故换用另一把主机公钥。未知或变化的指纹先发布准确来源的 HostKeyTrust，再允许认证；保存仍在当前 Home 的私有信任文件，跨项目复用，Dev/正式版分开。模型不接收私钥、密码或自由认证参数。
- SSH PTY 接入原 create/history/input/resize/command/interrupt/disconnect 及资源终端 scope；仍为真实人类手动终端，不等于 Agent 获得任意交互输入权限。Shell 失败输出区分认证失败、地址解析、端口拒绝、超时和连接中断。
- Worker 新增 `inspect_host`，只允许固定 system/disks/processes 只读模板，无模型 Shell 参数。读取准确项目资产、连接/凭据版本与主机指纹，尊重当前 Pilot 开关、原显式项目资源上限/能力/deny/ask/epoch、原任务步骤/owner/期限/未决操作。审批后的配置漂移不能派发，实际回执和当前信任身份参与原验收账本。资源 available 只说明配置可用，不证明网络或主机健康。

### 本地验证

严格 TS 检查和源码 bundle 通过；后端 **43/43**，前端类型检查及 **604/604** 回归、ADK runtime boundary 通过。

新增 SSH 测试使用真实 SSH 协议服务器、真实 PTY/本机子进程及真实 ZCode Worker，测试凭据均为合成值：

1. 指纹确认前零认证；批准后真实远程 PTY、持续状态、退出、重启信任复用与凭据遮蔽。
2. 公钥改变须再次确认；错误指纹/取消不能认证或静默改信任。
3. Worker 原工具审批前零 SSH 认证；批准后固定只读模板取得成功回执并完成原步骤/验收，频道确认内容来自准确 Worker。
4. 已部署 v1 上补 SSH 引用，原批次收据及 Go 数据 SHA 不变、零模型请求/新 Worker，TS 编辑不被重启覆盖。
5. 审批等待期间改连接配置不能认证/执行；明确项目 deny 不被 SDK 只读默认规则覆盖。
6. 认证失败有独立原因，输出不包含保存的密码。

前端另覆盖：有真实频道但没有实际确认项的 parked/waiting_user 任务不显示“需确认”；真实待确认项继续显示。

真实用户所报服务器的只读连接探测已使用原 Dev 私钥和已信任指纹取得 exitCode=0；没有自动信任新公钥或操作服务。具体主机、凭据引用和运行内容不进入此记录。

### 范围与未验证项

这不是全量 SSH/安全/资产等价验收。Agent 任意终端接管、完整受控命令/TaskGrant/对账、文件传输、SSH key picker、键盘交互/多因素挑战、主机算法整体迁换、全部 SSH 配置与 Shell/平台恢复仍未全面移植；原策略存在尚未支持的非空限制时拒绝，旧未决操作仍保留阻断。SSH 手动连接可用不代表旧任务已恢复或服务器已健康。

### 签名 Dev 安装与实机验证

使用 `scripts/build_lake_desktop.sh --dev --ts-candidate --install` 覆盖已授权的 Lake Dev，构建源码为干净的 `7b85928cb77420c2278aed209684e9d156ec9315`。安装包元数据与实际后端 SHA-256 一致：`d67a7c87ac2b354befe9ecc26f1c5e614484d3cd9740ab88789d3c53962fff32`。App 深度严格签名和 ZIP/DMG 摘要验证通过。

原生窗口显示 `Lake Dev · TS/ZCode`，bootstrap 确认为 TypeScript / ZCode 3.17.2、PTY 模式；实际 PID、Home 和数据目录属于当前 Dev。原 Go 主数据库、ADK 数据库、providers.json、Security control 与停机备份的字节摘要均一致。备份留存在本机私有目录，没有操作正式 Lake。

实机从资源列表点击用户所报 SSH 资源的终端按钮，成功创建终端并显示“已连接”；输入只读验证命令后实际返回 `SSH_DEV_OK`、`REMOTE_TTY_OK` 和 `Linux`，回到远端提示符。终端 history 同步包含这些输出，状态为 ready、user、interactive；保留连接供用户继续使用。此次复用原 Dev 已信任的主机公钥，没有接受新指纹或重放旧任务。指纹变化和 Worker 审批的认证前阻断由上述隔离协议测试覆盖；本次实机连接未触发新的确认弹窗。

原生专员侧栏不再显示没有实际确认项的“需确认”，当前四个频道的 needsConfirmation 均为 false。旧回复中的 unavailable 文字保留为历史，不代表修复后的连接状态；本次终端验证不构成服务器全面健康检查。

当前 API 清单仍为 118 项，46 项有候选证据、完整等价验收 0/118，20 个领域仍待完整验收，全量切换门禁继续 BLOCKED。
