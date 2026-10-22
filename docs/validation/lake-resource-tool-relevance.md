# 无关话题误用资源工具：规则修复

日期：2026-10-22。分支：`codex/resource-tool-relevance`，验证基线为 `2b635d064a47bb0fbfa723c730cd8fefe4d50fd6` 加本修复提交中的代码和提示词差异；最终提交 SHA 记录在 PR 验证证据中。

用户仅询问公开 GitHub 项目，却出现主机操作记录。未读取该会话实际工具记录，因此不将截图推断为已确认的执行路径。

代码检查发现：总身份规则已要求资源只用于实际任务，但 core 工具提示中的“目标缺失就调用 list_assets”、通用目标解析说明和 LAKE_TARGET_SCOPE 附加文本仍可能诱导模型枚举资源。此次统一这些规则：先判断本轮是否需要资源访问，再解析目标；公开网页/仓库介绍使用回答或网页工具；历史绑定和引用仅为相关资源任务提供上下文。继续检查原主机、在主机部署项目等任务仍可使用原目标和工具。未清空目标范围、修改权限或按关键词硬编码意图分类。

验证：

- 更新全配置提示词基线，保留所有工具目录哈希；未改变工具可用性或权限。
- `scripts/build_lake.sh` 通过：TypeScript 检查、Vite 打包、Go 构建及持久身份签名验证成功。
- `go test -race ./internal/ai ./internal/web -run 'Test(Identity|Persona|ToolOutputCannotGrant|ConversationStyle|Strategy|Directory|Question.*Directory|ResourceSelection)' -count=1` 通过；覆盖现有身份/权限、提示词分层与基线、目录目标及资源范围回归。首次 Web 检查因缺少内嵌前端产物未启动，在签名脚本构建产物后重跑通过。
- `go vet ./internal/ai ./internal/web` 通过。
- `python3 scripts/check_adk_runtime_boundary.py` 通过。
- `git diff --check` 通过。
- Node 22.22.0 低于项目声明的 24.14+，pnpm 提示引擎警告；构建正常完成。
- `scripts/build_lake_desktop.sh --dev --install` 在构建前被版本保护拒绝，缺少已安装版本提交 `2470233f3c58`。未绕过保护，未覆盖或重启已安装应用。

限制：这是提示词和上下文措辞的修复，不是服务端语义拦截；未使用真实模型验证工具选择，也未完成 Lake Dev 交互实测。现有权限检查不证明模型不会发起无关的已授权只读调用。需要真实模型复验“介绍公开仓库”“绑定主机后换话题”“继续检查原主机”“把项目部署到该主机”等场景，不能把提示词哈希或模拟模型测试作为模型行为保证。
