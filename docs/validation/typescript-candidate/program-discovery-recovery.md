# 程序查找失败误锁修复

命名说明：本文路径和协议名称映射为当前 TypeScript 后端名称；原验证 SHA 保留，历史输出以对应提交为准。

日期：2026-11-06。用户反馈再次比较数据库时，专员称之前的环境检查待核实，当前读取也被拦截。

## 实际原因

只读检查当前 Dev 的原记录后，定位到一条 Bash：`hostname; command -v mysql; command -v kubectl; command -v mysqldump`。实际正常退出码为 1，stdout 仅有主机名，stderr 为空，没有执行同步或数据库写入。最后一个可选程序查找未命中会使整条命令非零退出。

旧分类器允许普通程序发现免确认，但仍将它归为 opaque。随后通用 Bash 的失败处理将该失败记为 unknown，项目的未决写入检查又阻止后续普通 CLI，形成误锁。不是用户关闭了命令权限，也不是当前查询证明数据库不可访问。

## 修复与边界

- 字面量 `command -v/-V NAME...` 取得只读分类；整个命令链仍逐项检查。编译后的发现命令在独立标准 Shell 中保留实际目标 PATH，避免 `command -p` 把自定义安装目录替换掉。发现不执行被查找的程序。
- 可选程序不存在时保留失败退出回执，之后可另作当前权限允许的新检查。失败查找不构成成功业务证据。
- 旧 TS 仅接受字面量 hostname 与程序查找的完整链：核对原任务、Session、资源及配置版本、generation、原调用与命令 hash、实际宿主退出回执及准确 SDK assistant ToolPart。仅正常失败退出 1 且未取消、未超时、输出完整时可生成 `literal_program_discovery_v1` 宿主核验凭证。
- 核验凭证只记录准确原对象和内容 hash，不保存命令或秘密。原 Operation、commandExecutions、目标、尝试和验收均不改写；原调用 ID 仍不得重放。凭证与原操作或执行行不匹配时立即失效。
- 任意 SQL、kubectl/docker exec、动态展开、重定向、child 调用、未知/中断/超时进程及来源不全记录不走此兼容恢复。真正 unknown 写入、旧 Go 账本、当前权限、指纹、审批与资源版本约束继续生效。
- `work_read` 同时投影独立核验凭证，使 Agent 能区别“旧查找失败但已证实无写入”和真正未核实操作。启动只核验，不恢复任务、不派发模型或业务命令。

## 本地验证

| 检查 | 结果 |
| --- | --- |
| 前端全量测试 | 704/704 |
| 前端类型检查与构建 | 通过，保留既有 Vite chunk 提示 |
| Runtime 类型检查与打包 | 通过 |
| server／mysql／router-context | 120/120 |
| tasks／assets／activity／discovery-recovery／memory／superagent-lifecycle | 85 项：84 通过；1 项需要独立 Claude-Mem 检索端点的可选测试跳过 |
| ADK 运行边界 | 通过 |
| Dev 路径、来源与隔离 | 19/19 |

新增单元测试覆盖实际 PATH 查找且不执行程序、缺失程序退出 1、整条命令分类、旧回执精确核验、原行不变与禁止重放；输入、输出、hash、资源、generation、项目/会话、child、取消、超时、源缺失/重复及读取竞态的反例均维持阻断。

真实 SDK 与 SSH 协议夹具验证：缺失程序检查失败后，后续普通 CLI 仍执行且仅用新成功回执验收；从实际 SDK 档案恢复旧版表示，启动生成单一核验凭证而所有原行不变，两次重启均无额外 SSH 或模型请求。

另将用户这条准确原记录及档案只读抽取到私有临时文件，导入独立临时 LakeStore 离线验证：仅这一条查找失败可核验，原操作完整行不变，外部派发为 0。没有连接用户主机、读取当前数据库或重跑历史命令。

## Lake Dev 集成

修复代码提交 `affa04af` 基于 `origin/develop` 的 `406d0430`。为保留已安装的六类资源功能，本地验证分支 `codex/discovery-dev-validation` 组合资源 PR 190 的 `49bed546` 与本修复，产生干净候选 `5a344fe24da0d438c68ba9ae0cf29dc9baba4af1`；没有向 develop/master 直接推送，也没有合并任何 GitHub PR。

合并候选再次通过前端 710/710、后端集成 130/130、源码单元 86 项（85 通过、同一可选 Claude-Mem 测试跳过）、TS 类型及 bundle 检查。执行 `scripts/build_lake_desktop.sh --dev --ts-candidate --install` 构建、签名并安装；`codesign --verify --deep --strict`、构建来源 gitHead、dirty=false、实际后端 SHA256 均通过，Bundle ID 为 `com.cleanlakes.lake.desktop.dev`，启动 API 报告 TypeScript 后端。

安装前从原生菜单停止 Dev 内核，保留同一 Home 与应用的私有 APFS 克隆备份。安装、启动后与停机备份逐行比较：55 条目标／尝试／操作／交付／验收记录、16 条命令执行记录及 144 个资源完整行均不变。准确旧查找记录获得 1 条独立“无写入”核验凭证。只读使用实际同版核验器验证凭证及账本：原 unknown 结果仍保留，但该目标的未核实副作用阻断为 false，活动／排队 Worker 为 0。

原生 Lake Dev 已启动，没有发送业务消息、重新比较或同步用户数据库、重放原命令、修改原权限或触碰正式版。截图中的历史消息不被改写。后续提交仅补充验证文档与计划，不修改上述已测试代码；修复 PR 单独针对 develop，两个功能 PR 的合并仍需用户明确授权。本地验证分支保留为已安装候选 SHA 的来源。
