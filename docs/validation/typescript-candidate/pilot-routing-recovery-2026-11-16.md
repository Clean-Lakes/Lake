# Pilot 派单恢复提示与头像验收

## 原因与修复

用户提供的两条“再次检查”记录，都曾在 Pilot 首次 `route_work` 派单时携带上一轮的资源 ID。本条消息没有选择资源，因而触发 `resource_ids` 必须来自当前人类事件的校验。随后省略该字段的同次派单成功，专员正常完成检查；旧展示仍把第一次尝试计为“1 项失败”。

补充 Pilot 提示词和工具说明：普通追问通过前置任务上下文继续，不复制上一轮资源 ID。执行层的资源校验保持不变。只在同一会话、事件、请求与专员中，后续成功派单具备持久化回执、准确的任务归属及冻结的前置任务资源证据时，为首次失败添加只读恢复证明。前端据此显示“派单重试后已恢复”；原始失败、参数和错误内容保留，其他业务失败继续计数。

Pilot 头像由三道扁椭圆改为圆润水滴与内侧水线，侧栏、顶栏、消息和思考行共用 SVG。工作时仅水线轻动，外轮廓不再缩成小圆点；等待、错误和减少动态效果保留静止策略。

## 候选与检查

- 产品及签名 Lake Dev 安装 SHA：`b95a5e4fa099cdf6f22d1bebcdaacbd61720e0d2`，`dirty=false`，0.3.33 / TypeScript，PR #235 → `develop`。
- `pnpm --dir web-agent test:frontend`：**907/907** 通过。
- `web-agent/node_modules/.bin/tsx --test runtime/typescript/superagent-lifecycle.test.ts runtime/typescript/router-context.test.cjs`：**90/90** 通过。
- 新增前后端回归覆盖资源选择纠正及证据不足的情况；执行失败、不同请求及跨归属记录不能被成功重试掩盖。独立复核无遗留问题。
- `web-agent/node_modules/.bin/tsc --noEmit -p runtime/typescript/tsconfig.json`、前端类型检查及 `python3 scripts/check_adk_runtime_boundary.py` 通过。
- `npm_config_offline=true scripts/build_lake_desktop.sh --dev --install` 成功；签名、TypeScript 与 Web 构建通过，保留既有大 chunk 提示。

以上 Node 命令使用仓库缓存的 Node 24.14.0。后续证据提交只添加文档，不改变已验收产品代码。

## 浏览器

`web-agent/web/test/fixtures/pilot-routing-recovery.html` 使用真实 HeaderSweep、SuperRoleAvatar、AITranscript 和虚构派单记录，不连接业务后端。

验证恢复、未恢复、恢复后仍有业务失败、待确认和完成五种状态：恢复不再计入失败；真实失败仍显示“1 项失败”；待确认和错误停止头像动作。减少动态效果时头像动画为 0。390px 深色内容宽度等于视口，无横向溢出。14、20、22px 图标中的水滴实际高度约为 11、15.7、17.2px，轮廓保持饱满。

证据：[浅色](pilot-routing-recovery/light.png)、[深色窄窗口](pilot-routing-recovery/dark-390.png)、[状态采样](pilot-routing-recovery/browser.json)。

## Lake Dev 原生

退出旧 Dev 内核后安装并启动新签名版本，只读取日常 Dev 的现有记录，没有再次请求业务服务器检查。两条历史失败均取得准确成功重试的恢复证明，原始 `failed` 状态和错误文本仍在。

在原生主会话实际观察到两条“1 项派单重试后已恢复”；打开最新一条执行详情，依次看到“执行操作 · 重试后已恢复”和“route_work 首次失败 · 重试后已恢复”，展开后原始资源选择错误和参数完整保留。侧栏、顶栏及两条 Pilot 回复均显示新水滴头像。

已关闭执行详情，保留日常 Pilot 会话、原模型和资源列表，Lake Dev 正常运行。真实会话截图含业务信息，仅本地留存；仓库仅记录[脱敏的构建与结果摘要](pilot-routing-recovery/native.json)。

本轮原生验证为 macOS 浅色，深色及窄窗口由浏览器覆盖，Windows/Linux 原生未运行。提示词预防规则已检查，但没有通过重复真实模型请求来保证以后永不产生无效派单。PR 尚未合并，未操作生产 Lake。

同一 PR 前序的光效方向和进度连续性验证分别见[从左向右同步光效验收](specialist-light-direction-2026-11-16.md)与[进度连续性验收](specialist-progress-continuity-2026-11-16.md)，各自记录其测试 SHA。
