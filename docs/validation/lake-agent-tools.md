# Lake Agent 工具补齐验证

日期：2026-10-14

新增 16 个工具：todo_read、todo_write、ask_user_question、read_session_context、load_skill、list_workflows、get_workflow_run、run_workflow、save_workflow、schedule_create、schedule_list、schedule_update、schedule_delete、task_output、task_stop、read_tool_result。

基础目录从 43 增至 59；core 从 38 增至 54。启用项目记忆和多 Agent 时，主 Agent 目录为 60 个。terminal2 和数据库模式也可使用项目/会话工具，执行仍受后端范围校验和权限控制。

## 实际验证

- `go test -race ./internal/ai ./internal/web -timeout=120s`：通过（ai 22.249s，web 101.143s）。新增专项竞态测试也通过，覆盖 UTF-8 长行分页、脱敏结果恢复、跨会话结果拒绝、文件过期 hash、技能路径逃逸、问答回复/取消/重启、历史项目范围、工作流版本/所有权/继承权限、调度 claim 和重启跳过。
- `go test ./internal/ai -run 'TestImageToolBatch|TestPDFAdapter' -race -count=1 -timeout=30s`：通过。确认图片工具结果进入已有五种 provider 的视觉输入链路；PDF adapter 用隔离的合成执行文件验证参数和分页，未验证真实 PDF 内容解析。
- Node 24.14.0 下 `pnpm --dir web-agent check`：通过。
- Node 24.14.0 下 `pnpm --dir web-agent test:frontend`：99 项通过。
- `LAKE_TOOLS_BROWSER=1 go test ./internal/web -run '^TestToolsBrowserFixture$' -v -timeout=5m`：真实浏览器通过。无默认选中，选择测试环境后 Tab 进入自由输入，提交后问答消失，实际会话继续，两项 Todo 显示完成。模型为本地合成 fixture，不涉及用户凭据或外部服务。
- `scripts/build_lake.sh`：成功；`codesign --verify --strict bin/lake`：通过。Vite 有现有大 bundle 警告。
- `git diff --check`：通过。

截图：[问答提交后的任务进度](lake-agent-tools-completed.png)。

## 使用边界

- 技能放在 Lake home 的 `skills/<name>/SKILL.md`；CLI 配置 workspace 时也发现 `.agents/skills` 和 `.lake/skills`。技能加载仅返回当前允许目录内的文件，不改变权限。
- `read` 的 offset 是零起始行号；长行使用返回的 next_byte_offset。文本最大 16 MiB、每页最大 32000 字节；图片复用现有 2 MiB 图片限制。PDF 为文本提取，需 runtime 主机的 pdftotext，图片型扫描 PDF 需要另行 OCR。
- 计划时间为含时区偏移的 RFC3339；一次或最小 60 秒固定间隔，支持会话提醒和已保存的只读运维工作流。只有 Lake 后台运行时执行；重启跳过错过的时间，已领取但未确认完成的运行不重放。提醒和工作流进度通知显示在源会话中。
- 浏览器自动化、JS runtime 和通用动态工作流不在本次范围。
- 保留原有 shell_hooks.go、interactive_terminal_test.go 及其他与本任务无关的工作区内容；未操作真实生产资源。
