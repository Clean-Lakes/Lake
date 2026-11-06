# Pilot 停止与 MySQL 受控读取验证

命名说明：本文路径和协议名称已映射到当前 TypeScript 后端；历史提交 SHA 保留，原始命令与输出以对应提交为准，此映射不表示重新执行历史验证。


日期：2026-11-06。基线 `origin/develop`：`90aa12745eed6596f2313e3e4f9a7dac15d6700d`。实际测试、签名构建和安装的源码：`0db3281f84047ba5efeb3cc95bd70ba4ec180448`，构建来源 `dirty: false`。后续仅补充本验证记录、合成截图和实施计划。

## 修复行为

Pilot Router 结束回复后，输入区仍根据本项目真实 Worker 活动保留停止按钮；输入草稿时停止与发送同时可见，停止保留草稿。当前项目待派发输入及活动/排队/等待交互的 Worker 会取消，迟到路由不能再派单。历史停泊目标、其他项目及原 unknown 操作保留。续输入队列条件未改，避免把后台活动错误送到尚未移植的队列接口。

TS Worker 和原生 child 通过公开工具入口使用 `list_db_objects`、`db_table_ddl`、`read_db_table`；原 Operation 保存资源修订、连接/凭据摘要、库/schema 和行数/期限范围。当前权限、配置及证据在派发、验收和记忆使用时重验。元数据允许独立只读诊断；表数据仍受原 unknown 对账屏障约束。没有增加任意 SQL、写库、SSH 命令或 Kubernetes 数据库发现能力。

## 自动检查

以下 Node/pnpm 命令使用仓库固定 Node 24.14.0；锁文件中的 mysql2 为 3.24.6。

| 检查 | 命令 / 操作 | 结果 |
| --- | --- | --- |
| TS 类型 | `node third_party/agent-sdk/node_modules/typescript/bin/tsc -p runtime/typescript/tsconfig.json` | 通过 |
| Bundle / 许可 | `node runtime/typescript/build.mjs` | 通过；附完整 MySQL 生产依赖许可证及上游 NOTICE/COPYRIGHT（如存在），不改上游源码 |
| 宿主 / MySQL / Router | `node --test runtime/typescript/mysql.test.cjs runtime/typescript/server.test.cjs runtime/typescript/router-context.test.cjs` | **89/89**，无跳过：宿主 70、MySQL 10、Router 9 |
| 任务 / 资源 / 活动 / Memory / 生命周期 | `web-agent/node_modules/.bin/tsx --tsconfig runtime/typescript/tsconfig.json --test runtime/typescript/tasks.test.ts runtime/typescript/assets.test.ts runtime/typescript/activity.test.ts runtime/typescript/memory.test.ts runtime/typescript/superagent-lifecycle.test.ts` | **56/56**，无跳过 |
| 前端 | `pnpm --dir web-agent run test:frontend` | **652/652** |
| Web 类型与构建 | `pnpm --dir web-agent run build:web` | 通过；保留现有大 chunk 提示 |
| 运行时边界 | `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| Dev 隔离与来源 | `python3 -m unittest discover -s scripts -p 'test_dev_*py'` | **16/16** |
| 全量后端切换门禁 | `python3 scripts/check_typescript_parity.py` | **按预期拒绝切换**：118 项 UI 操作仍待完整等价验收，20 个领域未完成；没有修改门禁或宣称全迁移 |
| diff | `git diff --check` | 通过 |

MySQL 测试使用最小合成 MySQL 协议服务和真实 mysql2 驱动，验证独立只读事务、固定参数/标识符引用、回滚、连接关闭、取消、超时、网络/行/列元数据预算。真实 Agent SDK Worker 经本地模型夹具执行三个工具并生成原账本回执；旧审批遇到凭据变化不产生数据库 I/O，已成功回执遇到凭据变化也不可复用。跨项目、原策略 schema/限额、私有文件权限、符号链接和源数据库字节保持均有检查。共享资源表单的 sslmode 仅允许与 TLS 选项严格对应，不能关闭证书校验。

## UI 与签名 Dev

使用 ego-browser TaskSpace 10、实际 React 生产资源、真实 Agent SDK Worker 和显式临时 Home。本地合成模型让 Router 回复结束、Worker 等待 Write 审批。空草稿停止可用；输入后停止和发送同时可见。浅色默认宽度与深色 900×800 无横向溢出，图标尺寸、圆角和焦点保留。

浏览器驱动把带 `aria-disabled="false"` 的部分控件误判为禁用，且坐标点击未命中；最终使用公开 Page evaluate 调用真实 DOM 按钮 click，仍由应用的 React handler 发起真实停止请求。结果显示 Worker `stopped`、Task `cancelled`，待写文件不存在、草稿逐字保留。另有宿主集成测试确认原审批返回 409。未把这次回退操作称为原生鼠标点击验收。TaskSpace 已关闭。工具提示有 Ego Lite 更新，本轮未升级。

- [浅色、空草稿停止](pilot-stop-mysql-read/stop-light.png)
- [深色窄窗、停止与发送并列](pilot-stop-mysql-read/stop-dark-draft.png)
- [停止完成、草稿保留](pilot-stop-mysql-read/stopped-draft-kept.png)

日常 Dev 安装前确认所有现有 TS Worker 均为 parked、没有新活动，使用原生菜单“停止内核并退出”，私有备份现有 Dev Home 与应用。随后运行 `scripts/build_lake_desktop.sh --dev --ts-candidate --install`，打开 `~/Applications/Lake Dev.app`。原生界面确认 TypeScript 载入、目录层级和暂停历史保留、输入框可继续编辑；未在日常数据中注入合成业务任务。停止交互的明暗/窄窗验证范围是上述隔离 Web UI，未执行 Windows 验证。

`codesign --verify --deep --strict` 通过，后端签名为 `Lake Local Development Code Signing`；build-origin 的 backend SHA-256 为 `957b0ee365cd265b0d5a5512f41b81f1cc8a8720bf2c7281c840d448b0c4a4fc`。运行中 bootstrap 返回 `backendRuntime: typescript`、`aiRuntime: typescript`。仅操作 `.lake-dev`；未操作正式应用、正式 Home 或发布渠道。

## 当前连接与限制

日常 Dev 已精确导入 **5 个 MySQL 资源连接引用，0 个导入错误**，原目录及资源 ID 保留；其余 4 个未支持数据库资源仍不可用。没有复制或打印凭据，旧 Go 数据和历史任务没有重放。available/configured 只代表配置存在，不代表已验证网络、身份认证、MySQL 版本兼容或只读账号权限。

本次未查询真实远端数据库，也未继续用户之前的数据一致性比较。已有 K2 的 SSH 入口线索，不等于已获得可连接的 MySQL 服务；Kubernetes/SSH 内数据库发现仍未实现。结构、计数、分页和样本不能证明两端完整一致；跨服务器没有一致快照保证。完整 Security/grant、其他数据库驱动和全量 TS 迁移不在本次交付范围。

## 回退

停止 Lake Dev 内核，恢复私有备份的应用及同时间点 Dev Home 后再启动；不要将新 TS 数据反向覆盖到旧 Go 库。代码可经新的 develop PR 回退该修复。保留原 unknown、凭据文件及历史账本，不通过删库或修改门禁完成回退。生产版本未改变。PR 仅面向 develop，本次未执行合并或发布。
