# SSH 执行终端与窗口接管效果

Issue #86 的试用实现。执行 SSH 命令时，右侧自动展开只读 xterm，按当前会话、本轮起始时间、实际终端和 generation 筛选命令块。工作台边缘的蓝色流光由真实执行状态驱动，不执行、重放、接管或创建终端，不发送输入或远端 resize。

## 本地检查

- Node 24.14.0、项目固定 pnpm 10.33.4：`pnpm --dir web-agent check`。
- `pnpm --dir web-agent test:frontend`：449 项通过，包括新增 5 项 SSH 资源/会话/轮次/generation 隔离、命令输出追加和动效停止条件测试。
- `scripts/build_lake.sh`：前端构建及持久身份签名成功；使用 `Lake Local Development Code Signing`，未使用未签名二进制。
- `git diff --check`。
- 实际测试的提交 SHA 记录在对应 develop 草稿 PR 的验证部分。

## 浏览器验证

使用 ego-browser，TaskSpace 65；Vite 仅监听 `127.0.0.1:5186`。以下 fixture 完全使用虚构内存数据，不连接模型或 SSH，不读取真实凭据。

- `/test/fixtures/ssh-execution-workbench.html`：真实 App、SSE、snapshot、终端历史读取与组件集成。
- `/test/fixtures/ssh-execution.html`：独立观察器与终端组件。

已验证：

- 新命令自动展开右侧终端，连续命令和输出增量追加；未混入历史接口的原始手动屏幕。
- 蓝色边缘与扫光不拦截鼠标；草稿在输出追加、审批和断线期间保留。
- 等待确认、任务完成和断线时停止流光；断线保留已收到的输出，恢复连接继续显示。
- 403 撤销访问后移除终端及流光，恢复授权后重新读取。
- 手动收起后同轮更新不反复打开，标题栏可重新展开；完成后保留最后输出。
- 恢复已完成历史不自动打开，可以手动回看。
- 人为延迟历史响应后切换到另一会话，迟到结果不恢复旧终端或流光；完整工作台的终端写请求计数为 0。
- 向上滚动后可见文本保持原位，后续输出继续接收；回到底部恢复跟随。
- 浅色、深色、390px 窄窗口：无横向溢出，关闭按钮可见，复用既有抽屉布局。
- `prefers-reduced-motion: reduce`：扫光和呼吸动画关闭，保留静态状态与蓝边。

## Dev 验证限制

安装前执行 `scripts/dev_build_origin.py check`，发现已安装的 Lake Dev 来源为另一工作区的 `f93bb7905e5b`（`codex/dev-k8s-kubeconfig`），该提交不在当前 `origin/develop` 祖先链中。来源保护拒绝覆盖，未绕过检查、替换或重启已安装的 Lake Dev。未操作正式版 Lake、生产数据或真实远端资源。

因此浏览器验证与签名构建通过不等于已完成 Lake Dev 原生 WKWebView 和真实 SSH 联调。PR 保持草稿，合并前须在包含现有 Dev 功能的集成提交上补验；本次未授权合并或发布。

## 回退

回退本次前端提交即可移除自动展示及流光。后端接口、SSH 生命周期、权限配置、凭据和命令历史均未变更。
