# 专员名称后的 Agent Logo

2026-11-12。实际测试源码和签名 Lake Dev：`02decf7a0aa3aea243ba1984a2e72181a4849e15`。后续验证文档及截图不改变构建输入。

## 行为

沿用现有界面，在侧栏、专员页眉和 Pilot 报告署名的专员名称后显示 14px Agent Logo，保留名称前的湖生态头像。Lake 使用原协调者水波，Codex 复用 ProviderIcon 和本地 OpenAI SVG；兼容的旧 ACP 使用通用连接图标。当前支持的执行者仍为 Lake／Codex，效果图中的其他品牌不因此成为已接入能力。

侧栏读取当前角色绑定，报告保存原 Worker 冻结的执行类型。缺少字段的旧报告仅按准确项目、Worker、RoleID、执行会话和任务关联补充只读显示，不改写存储或从模型／名称猜测类型。修改专员的新任务默认 Agent 后，旧报告保留原 Logo。没有新增导航、会话、权限或执行流程。

## 本轮检查

| 检查 | 结果 |
| --- | --- |
| 前端和 TypeScript 后端类型检查 | 通过 |
| 全部前端单元测试 | 807 项通过，0 失败／跳过；包含 3 项新增 Agent 身份回归 |
| `superagent-lifecycle.test.ts` | 74 项通过，0 失败／跳过；包含报告冻结、只读旧记录投影及错误绑定回归 |
| `check_adk_runtime_boundary.py` | 通过 |
| `check_backend_naming.py` | 0 违规 |
| Web 生产资产构建 | 通过，保留原 chunk 大小提示 |
| `scripts/build_lake_desktop.sh --dev --install` | 签名构建和安装通过 |
| `codesign --verify --deep --strict`、`dev_build_origin.py check` | 通过，准确 clean 源码 SHA |

Ego 使用真实 App 的内存夹具 `specialist-task-list.html?session=demo-session-0&agent-logos&plain`，不连接模型或主机。检查浅色和深色 1280×900，以及深色 380×820 的导航与对话，均无横向溢出，Logo 为 14×14px，名称和头像保留。宽屏键盘 Tab 焦点有描边，轮询和修改默认 Agent 后焦点保留；当前角色切至 Lake 时，旧报告仍显示 Codex，夹具没有业务写请求。窄窗通过原按钮的 DOM 点击检查导航展开和收起，不把模拟点击称为原生键盘验收。类型提供悬停提示和完整无障碍名称。

- [浅色界面](agent-logos-light.png)
- [深色界面](agent-logos-dark.png)
- [窄窗对话](agent-logos-dark-380-chat.png)
- [窄窗导航](agent-logos-dark-380-nav.png)
- [浏览器尺寸及 Logo 位置](agent-logos-browser.json)

## 签名 Dev

原 Dev 正常停止后安装并重新打开 `~/Applications/Lake Dev.app`，真实界面确认原 7 个专员入口、原湖生态头像及新增 Agent Logo；当前项目的六位自定义专员均按实际默认绑定显示 Codex，没有为演示修改其配置。

应用 Bundle ID 为 `com.cleanlakes.lake.desktop.dev`。私有认证生命周期接口核对当前 PID、TypeScript 后端、`~/.lake-dev` Home／data 和非退出状态，实际进程来自 Dev 应用的 `Contents/Resources/lake`。安装后端 SHA256 为 `24c7f0c61b5f69d77d5e3a049364564e73b412287ca811d2ba51a3f0af0e6211`。

本轮没有发送模型消息、派发实际任务或改写历史 Agent 绑定；标准安装器沿用既有迁移入口。未重跑完整后端／Go／race／vet、其他平台或真实多 Agent 业务，不把既有验证当作本轮重跑。演示浏览器及专用 Vite 已关闭，Lake Dev 保持运行。生产应用、发布和 PR 合并不在本轮范围内。

回退通过撤回本轮源码提交并重新签名构建 Dev；新增报告字段可选，不需要回灌数据库或重放任务。
