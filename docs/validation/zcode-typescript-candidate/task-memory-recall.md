# 任务接续与 Claude-Mem 本地检索验收

日期：2026-11-06。范围：PR #188 的 TS/ZCode 候选；本批修复新专员任务丢失先前已确认入口和实例的问题，并按用户要求试接 Claude-Mem。

## 实现与权威边界

- 每个 Worker 保留独立 SDK Session。宿主从同项目、准确 RoleID 的原任务、已接纳用户补充和报告生成有字节预算的工作集；`recall_task_context` 可按查询、分页或准确 task/revision/hash 补查。
- 历史任务即使未完成或已取消，也可提供入口和实例线索；原状态、未决操作、轮次、期限和验收保持不变。历史上下文不能授权写入、重放未知操作或证明当前健康。
- 实际模型请求刷新当前任务的宿主工作集，不复制另一任务的 SDK 历史。原始任务、消息和操作记录不改写。
- `recall_memory` 读取当前有效且已启用的用户／项目／角色知识，返回 Lake 原笔记、revision 和来源引用。Worker 不能检索其他专员的私有记忆；临时子智能体不能调用两项宿主召回工具。
- Claude-Mem 15.10.0 和 Bun 1.4.4 使用私有 Dev 安装目录。上游仅提供可重建 SQLite 检索索引，ZCode 原生提取与 Lake 单一文件发布者保持。没有启用第二套 observer、Chroma、云同步或 IDE 全局 hooks。
- 索引采用独立 store/scope namespace、准确 fingerprint 和本地条目白名单，返回前重验资格。外部正文不直接进入模型。遗忘先停止读取并清理上下文派生知识，索引删除失败留持久标记，服务恢复时重试。
- 私有 worker 使用仅 loopback 的 HTTP 和随机凭据，拒绝无凭据及浏览器 Origin 请求；凭据不放入命令、环境值或日志。关闭时只停止宿主拥有的进程。运行时包、preload 和 Bun 校验 SHA256。
- 停止时先中止 SDK，再等待已派发宿主调用写入结果，避免停止接口已经返回、操作仍短暂留在 dispatched；写入副作用无法确认时仍为 unknown。

安装、停用和限制见 [Claude-Mem 适配说明](../../../runtime/claude-mem/README.md)。

## 本地验证

使用固定 Node 24.14.0／ZCode 3.17.2；真实上游检索测试只含虚构知识和临时 Home。

| 检查 | 结果 |
| --- | --- |
| `npm --prefix web-agent run test:frontend` | 692/692 |
| `npm --prefix web-agent run build:web` | 通过；保留既有 Vite 大块提示 |
| `node third_party/zcode/node_modules/typescript/bin/tsc -p runtime/zcode/tsconfig.json` | 通过 |
| `node runtime/zcode/build.mjs` | 通过 |
| `node --test runtime/zcode/server.test.cjs runtime/zcode/mysql.test.cjs runtime/zcode/router-context.test.cjs` | 118/118 |
| 固定 tsx 执行 tasks/assets/activity/memory/superagent-lifecycle/claude-mem 测试，显式开启两个隔离真实上游测试入口 | 69/69 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `python3 -m unittest discover -s scripts -p 'test_dev_*py'` | 19/19 |

SDK 协议夹具运行真实独立 Worker：先记录 K2 入口和实例，后以短句“同步到k2”分配新任务。新 Worker 收到历史入口／实例并调用 `recall_task_context`，未重新询问已知入口；只读取临时本地文件，不实际同步数据库，原目标和操作账本不变。

其他回归覆盖跨项目／RoleID 拒绝、伪造 actor、准确引用失效、Unicode 字节预算、分页、任务原约束、忽略记忆、来源撤回后的接续阻断与派生记忆清理。真实 Claude-Mem worker 已验证保存、检索、batch、版本替换、删除、鉴权、Origin 拒绝与所属进程退出；真实 Lake 记忆返回原文和来源，遗忘后无法召回。

## Dev 安装复核

- 安装并测试的源码 SHA：`8bba0756f7aa1d63874b0f2e690d750c1ddd4976`，构建时工作区干净。
- 使用 `scripts/build_lake_desktop.sh --dev --ts-candidate --install` 签名构建／安装，`codesign --verify --deep --strict` 通过；实际后端 SHA256 与构建来源一致，Bundle ID 为 `com.cleanlakes.lake.desktop.dev`。
- 原生设置页已显示“已接入 Claude-Mem 本地检索”，项目自动积累和读取开关保持开启。浅色正常窗口、深色窄窗口检查文字、圆角、分组裁切及可读性；复核后恢复跟随系统主题与原窗口尺寸。
- 实际索引 worker 的 health 为 15.10.0，PID 归属于新 Dev 后端，未鉴权请求返回 401；私有设置确认 observer／Chroma／云同步关闭。
- 144 个资源、当前项目 4 个有效专员及 51 条 canonical 目标／尝试／操作／验收／交付记录保留，安装前后整行哈希一致，运行或排队 Worker 为 0。没有发送业务消息、填写待补充问题、恢复或重跑用户已停止的 MySQL 任务。
- 安装前停止 Dev 内核，并备份私有 Home 与应用；正式 Lake 和正式 Home 未改动。后续提交仅补充验证文档，未改动已测试代码。

## 限制

此次接入为 macOS arm64 Lake Dev 的可选本地 SQLite 检索，未验收 Windows／Linux、向量检索或长时间真实模型推断质量。此前旧任务没有自动补提取为长期记忆；任务历史召回可独立提供线索。完整 ZCode 迁移仍受原等价门禁约束，本批不构成正式版切换或发布。
