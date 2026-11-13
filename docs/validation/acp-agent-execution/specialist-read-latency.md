# 专员未读与任务流程验证（2026-11-11）

源码及签名 Lake Dev：`b77ab66b6664a9fe78dced26e90fd3a1f841e8f7`，macOS arm64。用户明确选择保留本机 Codex `gpt-6.1-sol / max`，只优化执行流程。结构化结果见 [验证 JSON](specialist-read-latency.json)，实施见 [计划](../../../plan/refactor-specialist-read-and-latency-1.md)。

## 原因与最终行为

任务列表改版后，只有最新报告的结果页底部挂载自动读取标记；默认打开执行过程，且完整历史和待核实列表可能把标记推离视口。现在头部提供“标记已读”，只确认点击时当前频道已交付的游标。已有报告且不在执行或等待交互的任务优先打开结果页，自动标记紧跟与最新准确任务及正文一致的报告。列表、旧报告和后台窗口不自动读取；失败、新游标及跨专员的迟到响应不被乐观清零。

只读检查了既有运行的调用时间和工具回执：一轮约 453.67 秒，ACP 启动约 4.47 秒，根 Worker 的工具墙钟并集约 22.22 秒，29 次工具调用中包括两次失败的完成提交。其余时间包括模型调用、服务传输和子执行等待，不能一概当作纯推理。原未决操作与缺少业务证据共用错误文字，导致模型取得检查数据后仍补做无关观察并再次提交。

共享 Worker 现在要求先取得有界概况、复用已有上下文、只对异常深入、避免无收益的子任务和待办更新。TaskOutput 的宿主描述使用原句柄有界等待，不引导读取子会话全文。完成校验明确区分 unresolved_operations，提示一次提交部分结果；新检查不结清旧 unknown，原权限、期限、幂等和验收保持。

## 验证

| 项目 | 命令或操作 | 结果 |
| --- | --- | --- |
| 后端类型及构建 | 固定 Node 24.14.0：`tsc -p runtime/typescript/tsconfig.json`、`node runtime/typescript/build.mjs` | 通过 |
| 后端单元 | `node --import ./web-agent/node_modules/tsx/dist/loader.mjs --test runtime/typescript/*.test.ts`，对应 TSX 配置 | 268 通过，4 项既有可选跳过 |
| 宿主集成 | `node --test runtime/typescript/server.test.cjs` | 192 通过；包含读取持久化、旧游标及重启 |
| 固定真实 Codex ACP | `LAKE_CODEX_ACP_TEST_ADAPTER=/tmp/lake-codex-acp-validation LAKE_CODEX_ACP_TEST_NODE=/opt/homebrew/bin/node <Node24> --test runtime/typescript/acp.integration.test.cjs` | 4 通过；adapter 2.2.2、engine 0.160.1、本地合成 Responses；max 继承，未决诊断后 partial 不新增业务检查，原 unknown 不变 |
| 前端 | 类型检查、`test:frontend`、签名构建内 Web 构建 | 798 通过，类型与构建通过；原 Vite 大分包提示仍存在 |
| 边界及命名 | `check_adk_runtime_boundary.py`、`check_backend_naming.py`、`test_check_backend_naming.py` | 边界通过、0 命名违规、5 单元通过 |
| 浏览器 | ego-browser，实际 App 配合虚构 API，不启动第二个真实后端 | 显式已读失败重试、新消息竞态、跨专员迟到响应、旧报告不清新消息、最新报告可见性、原生前台条件、键盘、明暗主题与 620px 窄窗通过 |
| 实际 Lake Dev | `scripts/build_lake_desktop.sh --dev --install`，深度签名与 build-origin 核对 | 干净准确来源及后端哈希通过；33 项专员任务保留，实际点击“标记已读”后点消失，API 确认 cursor 等于 seenCursor |

## 数据保留与安装

安装前原 Dev 已进入 draining，但清理流程没有退出。确认无活动 Worker/频道/Router、无 starting/running ACP、没有子进程，且 loopback 生命周期、PID、UID、可执行路径及独立 Dev Home 一致后，先创建权限私有的 SQLite 一致性快照，再结束该准确闲置进程。未删除 runtime、锁文件或运行账本；正式版未启动或替换。此次未定位旧内核清理挂起的根因，不宣称已修复该问题。

重启后逐条哈希核对：128 条 TS Worker、128 条目标、167 条尝试、354 条规范操作、162 条验收、4 条 ACP 运行均不变；13 类共 672 条旧版记录不变。241 条命令记录中，240 条完全不变，1 条原本遗留 running 且规范 Operation 已为 unknown 的命令记录，经原有启动恢复转为 unknown 并补 finishedAt；其内容、结果和原 Operation 没有改写或重放。全部 150 个可见 Worker 保留。本机 Codex 配置全文哈希不变。

## 限制与回退

本轮没有外网真实模型推理，没有连接服务器、重跑旧任务、清除 unknown 或更改原验收。合成模型决定调用顺序，因此只能证明流程和协议正确，不能证明真实 max 模型的加速比例。其他 ACP 平台、Agent 和此前兼容限制继续见 [兼容记录](compatibility.md)。Go/race/vet 未在本轮重跑；无新增自动 CI、合并、生产安装或发布。

回退可撤回本轮代码提交并重新签名构建 Dev。已读是单调通知元数据，不回退到未读；原任务、操作和验收不因 UI 回退而改变。未将旧 Dev 数据快照回灌，以免覆盖后续合法记录。
