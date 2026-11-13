# SSH 自动换钥与专员任务总览验证（2026-11-11）

已测试源码与签名 Lake Dev：`cf444aa0618a6e063588e0cef0369d27f53c15c7`，macOS arm64，固定 Node 24.14.0。实施见[计划](../../../plan/refactor-ssh-trust-specialist-view-1.md)，结构化结果见[验证 JSON](ssh-roles-overview.json)。本轮按用户进一步要求，取代[上一轮](ssh-first-use-trust.md)“不同已存公钥仍需人工确认”的策略。

## 最终行为

首次连接和已存指纹变化均在后台沿 `LakeSSH.authorize -> decide` 原校验与原子写入路径保存实际公钥，保存成功后才发送认证，不发布指纹确认。匹配已存公钥直接复用。算法配置优先已存算法，同时保留 ssh2 默认支持算法，允许 RSA 到 Ed25519 换钥。凭据、资源归属与版本、全局状态、取消、保存权限及业务验收仍沿原路径。自动接受观察到的新公钥不提供独立身份核对，也不证明旧身份连续性。

专员角色页仅展示任务列表，移除输入框和“新建任务”按钮；空态引导由 Pilot 派发。资源添加到对话入口不在角色页挂载，文件拖入不上传或污染隐藏草稿。Pilot 的输入、模型、附件和草稿保留；任务详情里的业务问题、审批和执行控制仍使用原协议。

## 检查

Node 命令使用固定 Node 24.14.0；TS 单元设置 `TSX_TSCONFIG_PATH=runtime/typescript/tsconfig.json`。

| 检查 | 命令或操作 | 结果 |
| --- | --- | --- |
| 后端类型及构建 | `tsc --noEmit -p runtime/typescript/tsconfig.json`、`node runtime/typescript/build.mjs` | 通过 |
| 后端单元 | `node --import ./web-agent/node_modules/tsx/dist/loader.mjs --test runtime/typescript/*.test.ts` | 272 通过，4 项既有可选跳过 |
| 完整宿主 | `node --test runtime/typescript/server.test.cjs` | 198 通过，0 失败/跳过 |
| 固定真实 Codex ACP | `LAKE_CODEX_ACP_TEST_ADAPTER=/tmp/lake-codex-acp-validation LAKE_CODEX_ACP_TEST_NODE=/opt/homebrew/bin/node <Node24> --test runtime/typescript/acp.integration.test.cjs` | 4 通过；adapter 2.2.2 / engine 0.160.1，本地合成 Responses，无真实外网推理 |
| 前端 | Web 类型、全量单元、签名脚本 Web 构建 | 通过 / 798 通过 / 通过；全部单元在最后一行 Files 拖放限定后重跑 |
| 边界及命名 | `check_adk_runtime_boundary.py`、`check_backend_naming.py`、对应 Python 单元 | 通过 / 0 违规 / 5 通过 |
| 浏览器 | 完整 App + 虚构本地 API；浅色 1440px、深色 620px | 无输入/新建/资源添加入口，无横向溢出；筛选、目录搜索、键盘已读、任务问题、焦点恢复及 Pilot 草稿通过 |
| 签名 Dev | `scripts/build_lake_desktop.sh --dev --install` | 来源准确、dirty=false、Dev bundle ID、后端 SHA256 与深度签名通过 |
| 实际应用 | 正常退出旧 Dev 后安装启动，从侧栏打开专员总览 | 原 34 项任务正常显示，输入框与新建按钮均无；原状态及执行绑定保留 |

## SSH 协议证据

真实 loopback SSH 分别覆盖 RSA 同算法和 RSA 到 Ed25519 换钥：在服务端接到认证前，私有信任文件已经保存新公钥；全程没有指纹 prompt。重启后复用最新公钥，旧 peer 的 `revalidate` 仍拒绝，失效的人工决定返回 409 且不能覆盖最新记录。

换钥写入故障时旧信任记录保持，零新增认证；没有将保存失败视为连接成功。首次、并发、取消及原实际 PTY 测试继续通过。服务器、公钥、凭据与资源均为隔离测试数据，没有连接实际业务主机。

## UI 交互证据

[浏览器记录](ssh-roles-browser.json)及截图均使用虚构 API 夹具：[浅色总览](role-overview-light.png)、[深色窄窗](role-overview-dark-narrow.png)、[窄窗任务详情](role-inspector-dark-narrow.png)。浏览器空间与 Vite 已结束。

验证角色页没有 composer、新建任务或资源添加到对话的 DOM。筛选和搜索使用原数据，已读通过键盘聚焦/Enter 提交准确 cursor；原任务问题回答提交到准确 Worker 的 `questionReply`，关闭详情恢复原行焦点。Pilot 中输入草稿，浏览专员后返回，文本、模型菜单和附件入口仍在。文件 dragover/drop 均被阻止；无 `/messages` 或 `/uploads` 写入。空页说明由 Pilot 派发。最后将 drop 限定为 Files，使任务问题中的普通文本拖放继续沿浏览器默认路径；此调整后类型和全量前端单元重跑通过，未另外模拟文本拖放。

## Dev 数据与配置

安装前确认无活动 Worker、频道、Router、ACP 或 running 命令，正常停止 Dev 内核并退出。安装后逐条哈希核对：19 个项目、151 个可见 Worker，129 条 TS Worker、129 条目标、183 条尝试、400 条操作、162 条验收、175 条报告、5 条 ACP 运行、287 条命令及 14 类共 689 条 legacy 记录保持不变。本机 Codex 配置全文哈希一致，继续跟随本机 max。

本轮仅保存小型私有哈希审计，没有新建完整 Home/数据库副本；此前删除的四处备份根目录均未重建。正式版未安装或重启，没有创建、重试或重放真实业务任务。

## 限制与回退

未测实际集群、外网模型推理与耗时，未重跑其他平台、Go/race/vet 或完整迁移等价；未触发自动 CI、合并或发布。原 Vite chunk 与 Swift build-system 提示保留。

撤回代码并重新签名构建可恢复原输入和人工换钥策略；不会删除已保存的公钥、回灌旧快照、改写旧操作或重放连接。已存公钥继续按实际保存内容读取。其余范围见[兼容记录](compatibility.md)。
