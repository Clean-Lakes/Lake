# 任务行协作专员头像组

2026-11-12。实际测试源码与签名 Lake Dev：`be01b280a0e805133533bab3011da3ed25a56aaf`。

## 行为与范围

任务行通过 `SpecialistTaskRow.members` 和 `TaskSpecialistAvatars` 展示参与专员。当前专员在前，其余读取该任务原有 `collaboration.participants`，按准确 RoleID 去重并稳定排列；同名不同角色保留，旧无 RoleID 记录回退原 Worker/session 身份。只允许同项目、同任务、同执行会话的快照补充成员，不按文字或资源猜测协作者，不更改原 Worker、任务导航或报告。

全为单人时保留原 24px 身份列及 22px 湖生态头像；存在协作任务时整列统一为 46px，避免标题错位。双列最多展示三个无底板头像，多余显示 +N；悬停与行的无障碍描述包含完整姓名。每位成员按实际执行状态独立运动，复用当前项目头像配置、隐藏暂停与减少动态效果规则。轮询、成员增减、顺序变化与换头像继续使用稳定身份节点，不新增行内交互按钮。

本轮仅扩展显示和演示夹具。没有更改共享合同、后端协作调度、权限、Agent／模型选择、任务报告或历史状态；没有在日常 Dev 数据中制造多人任务。后端源码相对上一实际测试提交 `8a2a0fd0bde21b09c0da6534fa560d044bcd662a` 无变化，对应后端测试见[原记录](specialist-random-execution.md)，不标为本轮重跑。

## 本轮验证

Node 使用仓库固定 `third_party/.lake-cache/node-v24.14.0-darwin-arm64/bin/node`，前端测试设置 `TSX_TSCONFIG_PATH=web-agent/web/tsconfig.json` 并使用 `web-agent/node_modules/tsx/dist/loader.mjs`。

| 检查 | 实际结果 |
| --- | --- |
| `tsc --noEmit -p web-agent/web/tsconfig.json` | 通过 |
| `node --import … --test web-agent/web/test/specialist-task-list.test.ts` | 13 项通过，含 5 项新增成员／头像组回归 |
| `node --import … --test web-agent/web/test/*.test.ts` | 805 项通过，0 跳过／失败 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `python3 scripts/check_backend_naming.py`；`python3 -m unittest discover -s scripts -p 'test_check_backend_naming.py'` | 0 违规；5 项通过 |
| `scripts/build_lake_desktop.sh --dev --install` | TypeScript 后端、Web 生产资产、原生签名构建与安装通过 |
| `codesign --verify --deep --strict`；`dev_build_origin.py check` | 通过；准确 clean SHA，dirty=false |

Ego 实页使用原 App 的虚构内存 API 夹具 `test/fixtures/specialist-task-list.html?session=demo-session-1&collaboration&plain`，没有连接模型或服务器。验证 1／2／3／6 位成员、+3、所有行标题对齐、浅色 1280px、深色 620／380px、悬停／选中／键盘焦点，均无横向溢出。单人夹具的身份列仍为 24px。

实际增加成员、反转服务端成员顺序和切换河狸头像后，原行、按钮、当前及同伴头像 DOM 节点保持，焦点不变。键盘 Enter 打开准确原任务，关闭后在下一帧返回原行；浏览没有业务写请求。浏览器 Accessibility 树确认完整六人描述；页面隐藏时动画暂停，减少动态效果时头像动画为 none。离线静止另由组件测试覆盖。

本机证据：`/tmp/lake-task-avatars-browser-qa.json`、`/tmp/lake-task-avatars-{final-light,dark-620,dark-380,single}.png`、`/tmp/lake-task-avatars-{front,types,boundary,naming,naming-tests,signed-build}.log`。不将这些本机路径当作仓库内附件。

## 签名 Dev 与原数据

正常停止旧 Dev 内核后安装并打开 `~/Applications/Lake Dev.app`。实机原 7 个专员入口、34 项任务及单人头像／Agent／时间对齐正常；只浏览，没有派发模型消息或业务命令。

- Bundle ID 为 `com.cleanlakes.lake.desktop.dev`，Home 为 `~/.lake-dev`，后端为 TypeScript，来源 SHA 如上。
- 安装的后端 SHA256 与 manifest 一致：`696e049e00cd2ff779f449f9ed21ed81ed478ecbf8fda13e9cfb80eb211128ad`；实际进程来自 Dev 应用 `Contents/Resources/lake`。
- 本轮新建私有逐条 hash 基线，安装前后 4 provider／6 settings、19 项目／151 可见 Worker、161 资源／154 树节点、21 角色／18 频道及全部尝试／操作／历史验收／报告／命令／ACP／旧版记录一致；原扩展／Skills 文件和本机 Codex 配置亦一致。
- 检查前后活动 Worker／频道／Router／命令／ACP 均为零，没有重放历史操作；四处已删除备份根目录仍不存在，没有完整 Home／数据库备份。已关闭本轮演示浏览器及专用 Vite，Dev 保持运行。

保留既有 Web chunk、SQLite 实验性和 Swift 参数提示。未重跑完整后端／Go／race／vet、其他平台或真实多人协作业务；没有安装或重启生产、发布、合并 PR。回退通过源码回退并重新签名构建 Dev，不回灌数据库或重放旧调用。
