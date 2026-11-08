# Pilot 派单、续派与实时状态一致性

命名说明：本文路径和协议名称已映射到当前 TypeScript 后端；历史提交 SHA 保留，原始命令与输出以对应提交为准，此映射不表示重新执行历史验证。


2026-11-06。代码及 Dev tested SHA：`4d168e80eec7aa6a519b8248a4763125b6b2474a`。

## 问题与修复

真实 Dev 记录显示：Pilot 将派单瞬间的 queued 状态写入长期正文，专员已执行甚至完成后仍显示“目前还在排队”；同一 event/part 先错误引用旧任务、随后成功建单，却一直累计“1 项失败”。已完成任务上的新检查误用 followup，闭合保护正确拒绝后，模型没有恢复建单。隐藏过程还会打断公开作者分组，重复显示 Pilot 名称。

- 回执区分 `handoff.recorded` 与带观察时间的调度快照；接单只确认已安排，实时阶段由实际 Worker activity 更新。真实失败、限制和用户操作仍说明。
- 当前任务焦点携带 lifecycle。成功完成/pass/无未决的任务可由新用户事件发起新检查并复用原专员，前序任务只作为有来源的目标上下文；不继承批准、权限或验收。解释问题不创建任务。
- 活动任务的补充只进入下一 invocation；结清屏障保留准确输入和本轮工具回执，不同时 SDK steer 和下一轮投递。路由失败的输入不执行，后续有效输入仍可继续。停止、原期限、原轮数保持，显式恢复控制只领取一次；无关聊天不恢复重启中断的旧任务。
- 主流程仅凭同一轮、同 event/part 的完整成功派单回执消除已恢复的派单失败计数与图标。真实失败、等待、未决仍显示；原失败卡完整留在执行详情。连续公开正文只显示一次 Pilot 身份，确认、错误、用户与专员作者切换仍分界。

## 验证

| 检查 | 结果 |
| --- | --- |
| 前端类型与构建 | `pnpm --dir web-agent check`、`build:web` 通过；既有大 chunk 提示保留 |
| 前端全量 | `pnpm --dir web-agent test:frontend`，652/652，通过，无跳过 |
| TS host 单元与生命周期 | 使用 tsx 运行 assets/tasks/activity/router-context/superagent-lifecycle，46/46，通过 |
| 实际 HTTP/SDK 集成 | `node --test runtime/typescript/server.test.cjs`，63/63，通过，无跳过，包含真实 loopback SSH、PTY、审批、原生子智能体及未决操作边界 |
| 后端类型 | `tsc -p runtime/typescript/tsconfig.json` 通过 |
| 架构边界 | `check_adk_runtime_boundary.py` 通过；完整 TS 等价仍 0/118、候选证据 46，不改变切换门禁 |
| 独立审查 | 前端恢复关联与身份分组、后端结清时序/恢复边界，发现问题已修正；独立生命周期/TaskLedger 26/26 通过 |

旧 server fixture 原本把仍活动、尚未结清的 Worker 强制设为 queued，却期待有有效原输入时不排队。现准确模拟前轮已结清、仅剩 blocked 输入，保留“不得假忙”的断言；新的生命周期测试另覆盖后续有效输入仍能排队。

## 真实模型与界面

使用 Dev 配置中的 `gpt-6.1-terra`，独立临时 Home、随机 loopback 端口、合成 SSH 服务与指标；未调用用户服务器或重试真实业务。三轮实际模型工具选择：

1. 检查测试服务器：真实 SSH 读取，completed/pass，接单回复“已安排检查测试服务器的负载、内存和磁盘。”
2. 用户只说“再试试”：同一准确专员、新 Task/Worker，重新读取当前指标并 completed/pass，旧 goal 字节内容不变；接单没有排队/尚未返回结果收条。
3. 要求解释刚才结果、不重新检查：没有新任务，新增 SSH 调用 0。

两次检查共 4 个合成 SSH exec，全部面向唯一合成目标。模型输出存在随机性，此实测不保证每次用词完全相同。

`pilot-worker-progress.html` 真实组件 fixture：前言→失败→恢复→回复，正文节点替换 0；只保留一次 Pilot 署名。恢复后主流程没有失败摘要，展开详情仍有原 failed route_work；实际检查失败和待确认仍可见。已目视检查浅色宽窗、深色 390px 窄窗，窄窗页面宽度等于视口，状态行省略但保留完整可访问名称。未修改历史正文，不以正则改写模型答案。

## Dev 安装与回退

使用 `scripts/build_lake_desktop.sh --dev --ts-candidate --install` 完成签名构建与安装。安装于 `~/Applications/Lake Dev.app`，运行 Home 为 `~/.lake-dev`。构建前工作区干净，`build-origin.json` 的 `gitHead` 为上方 tested SHA、`dirty: false`、`backendRuntime: typescript`；后续提交仅补充本验收文档。

- `codesign --verify --deep --strict` 通过；安装的 backend SHA-256 与来源清单一致：`dc57494bf48dad26b1f09debf1d55feb40f53c5750b0bf9925c1f87608574892`。
- 正在运行的进程来自安装包，并使用 Dev Home；bootstrap 返回 `backendRuntime=typescript`、`aiRuntime=typescript`、`upstreamVersion=3.17.2`、`terminalMode=pty`、`recoveryReadOnly=false`。
- 实际 HTTP 提供的 UI 与本次产物逐字节一致，SHA-256 为 `bb8e46dd2b2bdf1883d8f0e96bbca4b0d471880c4afec5c7e75b3d975004ab58`。
- 原生窗口显示 `Lake Dev · TypeScript`，原项目、资源与会话可加载；原已恢复的派单轮只显示用时，未恢复的历史失败仍显示失败数量。原生 AX 继续保留视觉隐藏的续接作者，供读屏识别。
- 启动后没有活动 Worker；24 条历史 assignment 为 22 archived、2 parked。未自动重试原业务。
- 安装与启动后，旧 `lake-web.sqlite`、ADK `sessions.sqlite`、`providers.json`、`security/control.json` 的哈希均与备份一致。

停内核后、安装前已在 `~/Library/Application Support/LakeDevBackups/pilot-dispatch-20261106-075331` 保留 Dev 应用与完整 Dev Home 私有备份。回退先停止 Dev 内核，恢复备份应用；只有确需回退 Dev 数据时再先备份当前 Home 后恢复对应快照，避免丢失安装后的新对话。未操作正式版 Lake 或正式版 Home。

本次是既有 TypeScript Dev 候选的修复，不代表全量迁移验收完成，也不授权生产切换或发布。
