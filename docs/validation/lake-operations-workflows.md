# 自定义子 Agent 运维工作流验证

日期：2026-10-12。

项目导航新增“运维工作流”，支持创建、编辑、删除和重复运行模板。模板包含名称、总目标和 1–7 个有序调查步骤；每步选择 Scout、Trace 或 Deep，并分配 1–3 个项目内资源。可增删步骤、上下移动、保存或保存并运行。所有调查成功后自动运行 Beacon，再由 Lake 汇总。

执行由服务器按模板强制启动真实子 Agent，每次运行有独立会话、版本和不可变模板快照。前一步提供有界结果摘要，移除上一步的证据引用标识，后一步必须采集自己的观察；Beacon 只接收原始证据。Lake 汇总请求没有执行工具。调查失败、用户停止某个子 Agent 或停止整轮均阻止后续步骤。重启后标记中断，不自动重放。模板删除保留运行快照；普通会话后续子任务不会混入工作流记录。

首版是手动运行的只读调查模板：Scout 使用固定主机指标/进程观察，Trace 使用指定绝对日志路径，Deep 使用数据库/Redis 固定观察。自定义目标不能扩展工具权限；不含任意命令、变更、条件分支、定时器或自动回滚。

## 检查

- `go test -race ./internal/ai` 全量通过。
- 工作流、子 Agent 和消息队列针对性 race 回归通过；工作流测试覆盖实际顺序、上下文交接、原始证据验证、非法计划预验证、无证据失败、整轮停止及单子 Agent 停止。
- Web 测试覆盖模板 CRUD、版本冲突、跨项目隔离、资源类型、重复步骤 ID、模板快照与删除保留、重启中断、实际 HTTP 运行、停止和运行中禁止插入新消息。
- TypeScript 检查和现有 78 项前端测试通过。
- `scripts/build_lake.sh` 签名 arm64 构建成功；`codesign --verify --strict bin/lake` 通过。
- 浏览器使用临时 Home、测试模型和本地日志文件；保存及排序实际执行 Trace → Scout → Beacon → Lake，版本 2 的快照保留，独立运行会话完成。未触达生产 SSH 或生产模型。
- 720、480、320 像素宽度下弹窗无横向溢出；无 JavaScript 异常。
- 5174 调试页面真实工作流入口和编辑器已验证；后端 4178 更新使用独立调试数据。

全量 Web race 回归通过（150.010 秒），包含已复查通过的 HexHub V4 导入用例。

## 浏览器截图

- `/Users/lingyunxieqing/.codex/visualizations/2026/10/12/01a12e13-5b06-7d72-9bf3-ab286948da00/lake-workflow-editor.png`
- `/Users/lingyunxieqing/.codex/visualizations/2026/10/12/01a12e13-5b06-7d72-9bf3-ab286948da00/lake-workflow-running.png`
- `/Users/lingyunxieqing/.codex/visualizations/2026/10/12/01a12e13-5b06-7d72-9bf3-ab286948da00/lake-workflow-completed.png`

未提交、未推送。调试服务的更新仅操作独立实例，不安装或重启原生客户端。
