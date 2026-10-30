# Kubernetes 操作与任务绑定验收（2026-10-30）

代码提交：`d449e14761e695984dc452e4788065797e954b2a`；基线为 `origin/develop` 的 `9d1c4c65f8419ae2cf306b19fd16318fdc04a771`，包含已合入的工作区入口调整。本记录后续提交只增加验收文字，不改变已安装代码。

## 行为范围

- 新增 Deployment、ReplicaSet、StatefulSet、DaemonSet 查询；保留 Pod 和有界日志查询。投影包含 UID、resourceVersion、ownerReferences 和副本/滚动状态，不输出完整 spec 或凭据。
- 原生 K8s 工具支持明确对象的副本调整、滚动重启、单 Pod 删除。先做 SSAR 权限预检，变更再次检查；审批、目录/引用范围、Plan 禁写、只读子角色及操作账本继续生效。
- 变更携带 UID/资源版本前置条件。拒绝和冲突记录为未执行，丢失响应保留结果未知；不自动重发。API 接受不当作 Ready 或业务恢复。
- `work_begin.asset_refs` 和实际通过权限检查的资源调用建立任务绑定；不继承其他资产的旧终端。多资源接续校验全部冻结身份。旧目标不自动换绑。

## 本地检查

| 检查 | 结果 |
| --- | --- |
| `go test -timeout 20m ./...` | 通过；Web 包 246.367 秒 |
| `go test -race ./internal/ai ./internal/kubernetes` | 通过；最后的派发前错误分类另经相关 race 回归通过 |
| `go test -race -timeout 20m ./internal/web` | 通过，561.793 秒；完整包对应 `1fd2dd5f`，最后派发前错误分类已在最终代码相关 race、全量普通测试和签名后端中复查 |
| `go test -race ./internal/web -run TestKubernetes` | 最终代码通过，4.841 秒 |
| `go vet ./...` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `pnpm --dir web-agent test:frontend` | 549/549 通过，已在同步 develop 后复查 |
| `pnpm --dir web-agent build:web` | 类型检查与构建通过；保留既有大 chunk 提示 |
| `git diff --check` | 通过 |

首次全量 Web race 检查在整个包累计运行 601 秒时触及默认 10 分钟上限，当时正在执行 `TestFirstSSHConnectionCombinesTrustAndTerminalCreation`（该测试才运行 4 秒），没有数据竞争报告。改用 20 分钟总时限重新执行整个包，不跳过该测试。重复启动的一份测试进程已停止，不将其计入通过记录。

## Lake Dev

- macOS Apple Silicon；使用 `scripts/build_lake_desktop.sh --dev --install`，签名身份 `Lake Local Development Code Signing`。已校验应用深度签名、来源记录及二进制 SHA256。
- `~/Applications/Lake Dev.app` 已重启，Home 为 `~/.lake-dev`；来源为上述干净提交。新后台 PID `87988`，本机健康接口可访问；窗口正常加载会话、输入框和工作区入口。
- 使用已安装的签名后端启动显式临时 Home、随机 loopback 端口，并连接本机模拟模型和模拟 Kubernetes API。完成 8 轮工具流程：绑定目标 → 工作项运行 → 控制器查询 → 权限预检 → 等待审批 → 单次缩容 → 回查 → 完成目标。
- 模拟验证通过：批准前 0 次变更、批准后恰好 1 次变更、2 次权限检查（单独预检与执行前复查）、目标最终 completed、绑定 runtime 为 kubernetes 且无旧主机终端。测试后正常终止隔离后台。
- 临时证据：`/tmp/lake-kubernetes-smoke-proof.json`、`/tmp/lake-kubernetes-dev-proof.json`；日志 `/tmp/lake-kubernetes-*.log`。

## 限制及回退

未操作真实 Nanjing-k1/UWB，未验证真实账号写权限、真实控制器调谐或业务恢复，也未验证 Windows 桌面。当前支持明确的三类变更，不包含任意 manifest、exec、Secret 或集群级删除。

没有更改真实集群权限或生产安装；新增任务绑定字段保存在原 JSON 中，旧任务继续按原身份恢复，不能通过升级自动改绑。已有错误绑定目标应结束后重建。若回退代码，先暂停/结束新版本创建的活动目标，保留操作账本，再通过指向 develop 的回退 PR 操作；不能把回退或上下文压缩当作重试授权。
