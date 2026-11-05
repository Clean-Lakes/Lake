# TS/ZCode 普通任务与对话续派验证

2026-11-05。用户授权保留 Pilot/独立 Worker，实施对话工作集、轻量执行、诊断与真实确认状态改造；完整 TS 功能等价验收仍未完成。本批只覆盖已接入能力。

## 改动与结果

- Pilot 读取当前频道最近四轮对话、已投递专员报告、准确任务引用及当前注册适配器/资源目录；16 KiB 工作集保持来源、UTF-8 与身份，旧档案不修改。历史阻碍带记录时间，不能当作当前能力结论。
- 普通新任务由宿主自动维护步骤、attempt 和回执，模型直接选择业务工具并明确提交 completed/partial。完成必须有本次 invocation 的成功业务回执，目录发现、失败、旧回执或自然语言不能形成验收。显式 Plan、旧多步骤及既有验收不隐式接管。
- 续派返回真实排队/运行/等待/限额结果；未知副作用禁止重放，但宿主证明的只读诊断不再被整任务/项目连带阻止。诊断不能清除未知记录或使整个任务通过。
- 明确 partial 报告按本轮交付记录自然呈现；无已验证交付的文字仍保留简短未完成说明。停止后的任务不因旧待投递补充自动复活。
- “需确认”只来源于活跃审批、计划或问题交互，旧 waiting_user/pending/question 不制造确认状态。

## 本地验证

| 检查 | 结果 |
| --- | --- |
| TypeScript 严格类型检查 | 通过 |
| 后端隔离集成 `node --test runtime/zcode/server.test.cjs` | 48/48，通过；无跳过 |
| 账本 `tsx --test runtime/zcode/tasks.test.ts` | 13/13，通过 |
| 请求工作集 `node --test runtime/zcode/router-context.test.cjs` | 6/6，通过 |
| 前端类型检查与测试 | 通过；608/608 |
| ADK 运行边界检查 | 通过 |
| 完整等价矩阵 | 118 项、候选证据 46 项、完整等价 0/118；20 个领域待验收，不允许完整切换 |

集成回归包含真实 loopback SSH 协议与审批、同任务短语续派、当前配置变更、凭据脱敏、停止与权限边界、未知写入禁重放、失败只读尝试恢复、Plan 精确确认、过期确认拒绝以及伪造验收拒绝。模拟模型只证明协议链路，另做下述真实模型验证。

## 真实模型多轮行为

使用 Dev 当前已配置模型，运行独立临时 Home、全新合成项目和 loopback SSH 服务。模型凭据仅在私有临时目录内使用，结束后删除；没有向模型发送用户实际服务器数据或操作用户业务任务。SSH 返回明确的合成指标，不能把这些数值当作真实服务器健康结果。

1. 用户要求检查“测试服务器”的当前负载、内存和磁盘，资源暂标不可用：创建一个任务，未发起 SSH；保存部分结果。
2. 恢复测试资源配置，仅发送“再试试”。
3. 真实模型选择 followup，同一 Task/Worker，未要求重复说明目标。
4. 实际发起两次 SSH 指标读取，获得成功回执；总计 7 个 Worker 模型轮次，最终 completed/pass。
5. 公开报告包含负载、内存和磁盘观察，没有内部验收字段或旧“无读取工具”的结论。

原始临时执行日志仅保留在私有本地验证目录，不提交模型凭据、实际 Dev 业务记录或主机配置。

## Dev 安装

修改前运行来源已核验：`fc4018c3b55cca599e6bbf3ee8ca77e277365228`，`backendRuntime=typescript`、`aiRuntime=zcode`、`upstreamVersion=3.17.2`，进程来自已安装 `Lake Dev.app/Contents/Resources/lake`，Home 为 `.lake-dev`。

本批源码和已安装 Dev 来源：`910f93c3cdde03eec894ae8f0d5773aa181bab84`，构建元数据 dirty=false。使用 `scripts/build_lake_desktop.sh --dev --ts-candidate --install`，App 深度严格签名与 ZIP/DMG SHA-256 校验通过。安装后可执行文件 SHA-256 为 `668d21654bba41ee746da75cca27a9aa834f274b552669d59a017ddf40b23998`，与 build-origin 一致。

原生窗口 `Lake Dev · TS/ZCode` 已打开并加载。运行接口再次确认 TypeScript / ZCode 3.17.2 / PTY，PID 为 27048，进程来自已安装 app，Home/data 分别为 `.lake-dev` / `.lake-dev/web-agent`；recoveryReadOnly=false，实际服务的 JS 字节与本次 Web 构建相同。没有活跃确认项时，频道需确认数量为 0。

安装前使用原生“停止内核并退出”，确认没有活跃任务/终端，并为 Dev app/Home 保留私有 APFS 克隆。安装后旧 Go 主数据库、ADK 数据库、providers.json 和 Security control 的四项摘要不变。未执行真实业务任务或连接用户服务器；上述多轮行为验证使用隔离合成 SSH 目标。正式版未操作。
