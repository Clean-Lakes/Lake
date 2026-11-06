# Lake Dev 的 Claude-Mem 本地检索

本适配使用固定的 Claude-Mem 15.10.0 npm 包及 Bun 1.4.4，来源、npm 完整性和许可见 [upstream.json](upstream.json)。上游为 [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)，采用 Apache-2.0；Bun 为独立运行时。本批不修改或把上游包重新打入 Lake 安装包，不安装 Claude Code/Codex 的全局 hooks。

## 安装与运行

```sh
python3 scripts/setup_lake_claude_mem.py --dev
scripts/build_lake_desktop.sh --dev --ts-candidate --install
```

安装和重新构建前先按仓库流程停止 Lake Dev 内核。安装器固定使用 `~/.lake-dev/claude-mem`，检查版本与 npm integrity，并记录 Bun、worker 和 Lake preload 的 SHA256。当前只验收 macOS arm64；不指向正式 Home，不复制正式凭据。

启动 Lake Dev 时，TS 内核在私有目录启动并管理 index worker，退出时停止自己拥有的子进程。包、索引数据库与私有 HTTP 凭据均位于同一 Dev Home；模型的本机文件/命令沙箱不能读取该 Home。`guard.cjs` 通过公开 Node HTTP API 给原包增加独立凭据检查，拒绝浏览器 Origin 请求；凭据不放入进程参数或环境变量，只通过私有文件交给 worker。`GET /api/health` 在无凭据时返回 401。

如不使用该试接，将私有 `index.json` 的 `enabled` 设为 `false`，然后按正常 Dev 退出/重启流程操作；已发布 Lake 知识仍保留。不要在 worker 运行期间替换运行时文件。

## 所有权与边界

- Lake Task 运行层提供同项目/准确 RoleID 的任务工作集和 `recall_task_context`，包含历史摘要、用户补充、报告引用和资源线索。未完成或取消的任务可以提供线索，状态、未决操作和原期限保持原状，不导入验收或许可。
- ZCode 原生 Memory 继续提取知识；Lake 仍是范围、来源、文件成品、更正与遗忘的单一发布者。`recall_memory` 在已启用的当前用户/项目/角色范围内检索有效知识。
- Claude-Mem 仅作为可重建本地索引：通过公开 `memory/save`、`search`、`observations/batch`、`observation/:id` 协议写入合格笔记的副本与准确 fingerprint。不同 store/scope 使用不同的散列 project namespace。
- 模型收到 Lake 原笔记及来源引用，不直接收到外部服务返回的正文。每次返回前重验资格、版本、作用域和遗忘状态；未知 ID、其他 namespace 或失效 fingerprint 不进入模型。
- 更正/遗忘先撤回本地读取，清理同源及上下文派生知识，再删除索引副本。不确定的索引写入以相同 fingerprint 找回 ID 后删除；离线清理保留持久标记，恢复后继续，设置页显示待清理状态。原业务操作和会话档案不删除。
- 此试接关闭上游 observer、cloud sync、遥测、媒体、转写、Notion/Telegram/Grok 及 Chroma。当前检索为本地 SQLite 模式，未声称启用向量检索或替换长期记忆生成引擎。索引暂不可用时可查本地有效笔记，实际降级状态可见。

## 验证

`runtime/zcode/claude-mem.test.ts` 默认覆盖协议、隔离、幂等、版本替换、不确定写入清理、重定向拒绝和迟到失效。真实上游测试须显式提供独立测试端点或运行时目录：

```sh
LAKE_TEST_CLAUDE_MEM_URL=http://127.0.0.1:端口 \
LAKE_TEST_CLAUDE_MEM_ENGINE_ROOT=/独立测试目录/engine \
web-agent/node_modules/.bin/tsx --tsconfig runtime/zcode/tsconfig.json \
  --test runtime/zcode/claude-mem.test.ts runtime/zcode/memory.test.ts
```

测试只使用虚构知识和临时项目，不向真实数据库执行同步。本地检索的真实性与凭据边界测试不等于长期真实模型推断质量、Windows/Linux 或 Chroma 已验收。
