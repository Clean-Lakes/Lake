# Lake TypeScript Agent 0.0.1

本分支从零实现 Agent 循环、模型工具协议、上下文、预算、专员工单和持久运维执行。`agent/` 是独立工程，不加载旧 ZCode/Tianshu Agent 内核。

一个会话可以有多个专员。每个专员有独立模型历史和冻结工单，默认继承诊断、coding、部署、调试、验证、报告六个 SRE 技能。SSH、K8s、PostgreSQL、HTTP 和本地项目是可组合 Power。会话持有终端、共享步骤、事实和证据。

## 构建与启动

使用 Node 24.14.0、pnpm 10.33.4。macOS 用户入口必须通过规定脚本构建：

```sh
pnpm --dir agent install --frozen-lockfile
pnpm --dir agent check
pnpm --dir agent test:unit
pnpm --dir agent test:integration
scripts/build_lake.sh
pnpm --dir agent test:acceptance
bin/lake version
```

集成/验收需要 Docker：先构建隔离 Linux 夹具 `docker build -t lake-agent-systemd-test:0.0.1 agent/test/fixtures/linux`，准备 `postgres:16`、`node:24.14.0-bookworm`，并确保 kubectl 可用。Linux 夹具使用 Docker Linux 虚拟化内的真实 systemd PID 1、SSH 和业务 HTTP，所有端口仅绑定回环；测试结束清理容器。

如果默认 Node 版本不满足要求，设置 `LAKE_AGENT_NODE` 为 Node 24 的绝对路径。签名身份缺失时先运行一次 `scripts/setup_lake_signing.sh`；构建不会回退为 unsigned。运行时和原生模块针对目标平台构建，macOS 与 Linux 分发不能混用。

开发运行：`pnpm --dir agent dev help`。构建输出使用 `node agent/dist/surfaces/cli.js`。完整分发在 `bin/lake-agent-runtime/releases/<version>-<digest>/`；launcher 校验 manifest、文件 hash 和内部符号链接后启动 Node。旧 release 不在构建时删除。

## 无需模型 key 的本地演示

安装开发依赖并构建 UI 后，可用 `pnpm --dir agent exec tsx test/fixtures/demo.ts` 打开三专员演示。它使用确定性 HTTP 模型和临时私有 home，不调用真实 provider，不访问生产；停止进程会清理演示数据。

## 首次配置

默认 home 为 `~/.lake`，可使用 `--home <path>` 或 `LAKE_HOME` 选择隔离目录。新数据位于 `<home>/agent/`，不自动迁移旧数据库、会话或模型配置。

将 `agent/config.example.json` 的结构保存为 `<home>/agent/config.json` 并设置私有权限。填写明确的 provider 地址、model、contextWindowTokens、maxOutputTokens 和工具/流式能力。地址使用 Chat Completions 兼容协议；凭据字段只使用 `credentialRef`。

通过私有 stdin 导入凭据：

```sh
bin/lake credentials import --kind models --id default --stdin < /private/path/model-key
bin/lake credentials import --kind ssh --id server-key --stdin < /private/path/ssh-private-key
```

仅通过重定向或 pipe 向 stdin 提供内容；交互终端输入会被拒绝，避免终端回显与 shell 历史。不要把实际 API key 或私钥放入 argv、仓库配置、聊天或命令示例。凭据目录为 `0700`、文件为 `0600`。`models/default` 保存 API key；SSH 文件保存私钥；database 引用保存 user/password 与可选 ca 的私有 JSON；kubeconfig 引用保存完整配置。

未配置可用模型时，`serve` 仍能管理资产和展示界面，模型任务会返回明确的能力/配置错误。

## 资源、服务与授权

`resources import --file <json>` 接受 `{lakes:[],environments:[],resources:[]}`；`services import --file <json>` 接受服务数组。ID 使用 UUID。资源包括所属 lake/environment、kind、endpoint、identity、私有 credentialRef 和 settings。网络 endpoint 不接受内嵌用户名、密码或敏感认证 query。

SSH settings 需要 username、允许的 units，以及配置路径到 `{checkArgv,unit,action}` 的明确绑定。checkArgv 使用 `{{file}}` 引用待校验文件，不能由模型临时改为任意 shell。identity 使用预先登记的 OpenSSH `SHA256:` 主机指纹。服务 health URL 必须绑定到同环境的 HTTP 资源。

K8s settings 明确 context/namespace；证书、私钥和 token 数据内嵌在私有 kubeconfig 中，拒绝外部凭据文件路径；exec 凭据插件默认拒绝。PostgreSQL 默认验证 TLS；只在明确受信的测试环境配置 `tls:false,allowPlaintext:true`。固定 SQL 不含任意用户 SQL。workspace.test 需要配置隔离容器 image/argv；沙箱复制受限项目快照，排除 `.env`、`.git`、`.lake`、secrets、私钥文件、node_modules 和链接；依赖应预装在受信镜像中。无可用容器环境时报告 capability_unavailable。

```sh
bin/lake resources import --file resources.json
bin/lake services import --file services.json
bin/lake grants create --resource RESOURCE_UUID --effects read
bin/lake grants create --resource SSH_UUID --effects read,change
bin/lake grants revoke GRANT_UUID
```

enable Power 不等于授权。读、变更、交互授权均绑定资源身份和版本；撤权会阻止排队动作并使相关事实失效。模型不能通过日志、技能或项目文件扩大权限。

## 运行与工作台

```sh
bin/lake serve --open
bin/lake open
bin/lake doctor
bin/lake run --lake LAKE_UUID --environment ENV_UUID --resource RESOURCE_UUID --prompt '检查服务异常' --json
bin/lake chat --lake LAKE_UUID --environment ENV_UUID --prompt '检查服务异常'
bin/lake chat --session SESSION_UUID
bin/lake sessions list
bin/lake sessions show SESSION_UUID
bin/lake sessions resume SESSION_UUID
```

`chat` 支持持续追加指令，使用 `/status`、`/resume`、`/approve <行动ID> <摘要>`、`/cancel`、`/quit`。`run --json` 适合脚本。恢复/配置变更使用 `--intent recover` 或 `--intent change`；工作台有相应任务类型。两类任务必须选择已导入服务的健康资源和目标资源，创建时冻结 HTTP 判据；配置变更还需要一项已验证的实际变更。诊断任务默认使用有来源的调查发现判据。

CLI/Web 连接同一 home 的唯一 daemon。Web 只监听 127.0.0.1，启动链接使用一次性 fragment 票据，兑换后立刻清除；访问 token 只在前端内存中使用，刷新通过 HttpOnly、SameSite=Strict 的会话 cookie 恢复。API 校验 Host/Origin，SSE 使用带 Authorization 的 fetch，不把访问 token 放进 query 或 localStorage。

工作台显示任务目标、共享步骤、专员生命周期/阶段/活动、行动审批、来源与有效期、终端持有者及报告。终端是 managed 操作视图或人工 SSH PTY；模型不能发送任意按键。人工接管先暂停新派发，核对在途动作，取得资源独占写控制并消耗绑定审批；交还确认手工操作停止并重新核对事实。人工租约到期关闭 SSH 通道并保留资源写锁，确认手工操作已停止后才能交还。CLI 接管使用 Ctrl+] 交还；Ctrl+C 发送给远端。

变更审批必须检查目标、参数、内容摘要和验收条件：

```sh
bin/lake actions show ACTION_UUID
bin/lake artifacts show ARTIFACT_UUID
bin/lake approve --action ACTION_UUID --digest ACTION_DIGEST
bin/lake cancel --task TASK_UUID
bin/lake criteria confirm --task TASK_UUID --criterion CRITERION_ID
bin/lake budget update --session SESSION_UUID --max-calls 100 --max-tokens 200000
```

run 退出码：验证完成 0、部分验证 qualified 2、失败/阻塞 1、等待审批或续跑 3、取消 130。机器结果在 stdout，进度和错误在 stderr。任务等待仍保留在 daemon。

## 验收与当前边界

含 `[REDACTED…]` 标记的整文件修改会被拒绝，避免把脱敏占位符写成配置。秘密字段的保留与注入需要后续专门的变更能力。

首版支持 HTTP 服务故障恢复和单 Linux/systemd 服务配置替换，使用备份、语法检查、hash 前置条件、原子替换和 HTTP 连续验证。失败回滚必须确认没有外部漂移，恢复结果与原变更成功分别记录。

K8s 和 PostgreSQL 只读。桌面安装壳、多租户、跨机器 daemon、任意 MCP 插件、定时自治、数据库写和 K8s 发布尚未交付。真实模型兼容性需对用户选定 provider 单独 smoke；本地确定性模型测试不代表所有兼容接口都通过。

见 [实际验证记录](validation/lake-ts-agent-v0.0.1.md)、[Power 契约](lake-ts-power-contract.md)、[恢复语义](lake-ts-recovery.md)、[实施计划](../plan/architecture-lake-ts-agent-v0.0.1.md)。
