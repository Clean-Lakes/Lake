# 专员与资源导航验证 · 2026-11-13

本次按用户选定的第一版实施：Pilot 固定，下面切换“专员 / 资源”；资源使用完整列表空间，保留新增、导入、目录、引用和终端入口。会话刻度改成按需打开的提问目录。产品文案与新提示统一使用“专员”，保留历史消息原文。

已安装并验证的干净源码提交：`c35d40ca0e2a32aacdac60bc06c732ca0fefb182`。应用为 `~/Applications/Lake Dev.app`，Bundle ID `com.cleanlakes.lake.desktop.dev`，版本 `0.3.32`，TypeScript 后端，使用原 `~/.lake-dev`。后台二进制 SHA256：`8e057c6dfa26308486b201c6e308dbec878d0a27c036ac0361f71a949285a08b`。构建来源、深度严格签名和实际启动的原生 Dev 窗口均已核对。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `pnpm --dir web-agent test:frontend` | 816 通过 |
| `pnpm --dir web-agent build:web` | 类型检查与构建通过；保留已有大分块提示 |
| `node third_party/agent-sdk/node_modules/typescript/bin/tsc -p runtime/typescript/tsconfig.json` | 通过 |
| `pnpm --dir web-agent exec tsx --test ../runtime/typescript/specialist-conversations.test.ts ../runtime/typescript/superagent-lifecycle.test.ts` | 91 通过 |
| `node --test runtime/typescript/specialist-conversations.test.cjs` | 新构建运行时、真实 SDK 与本地 HTTP/ACP 夹具 5 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `scripts/build_lake_desktop.sh --dev --install` | 签名、打包、Dev 安装通过 |
| `codesign --verify --deep --strict`、`scripts/dev_build_origin.py check` | 通过 |

所有 Node 命令使用仓库固定的 Node 24.14.0。

## 界面与交互

隔离组件夹具验证了 100 轮目录、End/Enter 跳转、重复提问分别定位、Escape 返回焦点，以及资源列表滚动 900px 后切换面板仍保留位置；草稿和右侧会话未改变。

安装后的真实 Dev 使用原项目及 Pilot 会话验证：固定区只有一个 Pilot，资源面板高度 716px；“专员 / 资源”切换不改变路由、草稿和文件夹折叠状态。引用 Local machine 后继续输入，检查了编辑焦点、非透明光标和选区不落入 caret anchor；测试草稿及引用已清空，未发送消息或连接终端。

目录仅一个入口、无刻度；真实提问从已加载的 86 轮继续读取到全部 105 轮，保留弹层且不打开执行检查面板。既有最新报数轮仍显示六位专员的真实署名，无完成计数或执行过程尾注。

检查了 1280×950 浅色/深色和 390×844 深色窄窗口的选中、悬停、键盘焦点、圆角和内容裁切。窄窗口资源区高度 610px，无横向溢出；目录完整处于视口内。目录避开 Lake Island；窄标题空间不足时收成图标入口。主题已恢复浅色，辅助浏览器和隔离 Vite 已关闭；原生 Lake Dev 保持运行，供用户直接试用。

截图：[专员](specialist-navigation/light-specialists.png)、[资源](specialist-navigation/light-resources.png)、[浅色目录](specialist-navigation/light-directory.png)、[深色目录](specialist-navigation/dark-directory.png)、[窄窗口资源](specialist-navigation/dark-narrow-resources.png)、[窄窗口目录](specialist-navigation/dark-narrow-directory.png)。指标见 [evidence.json](specialist-navigation/evidence.json)。

## 数据与范围

与停止旧 Dev 后的备份逐条比对：1780 消息、162 资源、23 长期角色、130 Goal、130 Worker、403 Operation、162 历史 acceptance、6 召集轮次等记录的 ID 和完整内容均一致。本轮没有新增模型调用、业务任务或远端资源操作；界面复用既有六位专员的真实回执。

本次只改变前端导航和 TypeScript 提示文案，未重跑 Go/race/vet、Windows/Linux 桌面或真实外部模型/业务资源检查。ACP 及多人对话的原有实测记录继续保留，不能以本次界面验证代替其他平台的验收。

回退备份：`~/Library/Application Support/LakeDevBackups/navigation-tabs-20261113-132751/`，根目录权限 0700。需要回退时先停止 Dev，再成对恢复其中的应用与 Dev Home。正式版应用和数据未变更。集成分支继续通过草稿 PR #224 指向 develop，未合并。
