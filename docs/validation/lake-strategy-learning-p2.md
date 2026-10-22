# 策略学习 P2 本地验证记录

日期：2026-10-21；macOS / darwin arm64，Go 1.26.6，Node 24.18.0，pnpm 10.33.4（corepack）。基线 `origin/develop@39b3053b9b3fe0fe26c49561563eba2ff91b5466`，工作分支 `codex/strategy-learning-p2`，gh 账号 bearqy。

## 检查与证据

| 项目 | 实际结果 |
| --- | --- |
| `go test ./...` | exit 0；最终源码 web 116.585s，其余包通过或缓存 |
| `go test -race ./internal/ai ./internal/web ./internal/strategy` | exit 0；web 254.220s，其余缓存通过 |
| `go test -race ./internal/web -run '^TestStrategy' -count=1` | exit 0；最终补充来源创建者、DDL 换行归一及损坏内容用例后再次通过，2.693s |
| `go vet ./...` | exit 0 |
| `python3 scripts/check_adk_runtime_boundary.py` | exit 0；未更改或放宽边界检查 |
| 前端 check / test:frontend / build:web | exit 0；337/337 通过；仍有既有大 chunk 提示 |
| Markdown 链接/围栏、gofmt、diff | 通过；4 份 Markdown 共 20 个相对链接存在，代码围栏闭合 |
| 签名 Lake Dev 构建/安装及隔离旧库升级 smoke | exit 0；`LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake_desktop.sh --dev --install`；deep/strict 验签与隔离升级 smoke 均通过 |

测试观察到：

- 迁移前快照保留已提交原消息，权限 0600；快照中没有 P2 表；升级后 integrity_check=ok、foreign_key_check 无结果；重开不重复备份。无效后继格式在重启状态写入前拒绝；组件建表中途失败不提交成功标记/部分表。
- 完全相同请求重放不重复资产、来源、版本或采用事件；同 key 异内容冲突，多个并发 CAS 只有一个成功；事件写失败时整个资产/候选/回执事务回滚。
- 正文精确换行与 hash 不变、旧版本不可 UPDATE、绑定精确版本回滚；停用不会伪造采用。损坏内容无法读取为有效资产或采用。
- 跨项目资产/来源拒绝；全局资产的项目绑定血缘被其他项目隐藏；私钥/常见凭据字段/带密码 URL 拒绝；逻辑删除移除当前表内正文和适用字段并 tombstone 手工来源，依赖来源的任务不能继续写回。
- 默认四开关关闭；项目设置继承/相交与预算上限；旧 token、租约到期、epoch 变更、来源撤回/原消息改动、资产删除、用户抢先编辑和项目归档/恢复均拒绝旧 worker 提交。
- 领取最多 3 次、单实验并发约束包括已取消但未对账的运行；外部终态可在归档后由可信宿主登记，不重开任务。
- 子进程在事务未提交、已领取、派发意图已提交、结果已提交四处以 exit 23 直接退出，未执行 defer Close。重启后事务回滚；无意图的领取可恢复；已有意图保持原 runtimeId/unknown，不能再次 Prepare；已提交结果重读只有一份候选和成功 outbox。

子进程测试的“外部启动”是临时文件中的合成标记，未连接真实 ADK 远端运行、模型、服务器或数据库。它验证跨存储边界协议，不代表 P4/P5 的运行时适配器已实现。P1 的真实模型请求记录和唯一操作账本路径未更改。

## 提交、Dev 与未验证项

源码与签名构建提交：`20d8f58e21fa560d194415d4d95885e4e0868c6b`，构建时工作区干净（buildDirty=false）。最终 PR head 只补充验证文档与计划勾选，另在 PR 中记录；生产代码及用例与该已测提交一致。

已安装 `~/Applications/Lake Dev.app`，后端 SHA-256：`654328464c52c7f46ce474d8c9eb01c145f7363d6c2bc0b02b599118de004c53`。没有重启已有 Dev 窗口，不能声称该窗口已加载新包。

真实签名二进制以临时 Home、随机 loopback 端口启动 Web 两次：升级一个包含合成用户消息的旧库，带认证 bootstrap 成功且未配置模型；消息保留，P2 前快照仅一份且权限 0600；重启不重复迁移；integrity_check=ok，foreign_key_check 无结果；策略资产/设置/任务表均空，新策略 API 为 404。随后仅在临时库中置入不支持的 DDL 标记，再启动被拒绝，原 investigating 状态未被重启对账改写。全过程模型调用为 0，临时 Home 删除。所有运行使用独立 Dev 或临时 Home，不读取/复制正式版凭据，不安装或重启正式 Lake。

未做 Windows 原生验证、真实 provider/资源 smoke、策略 UI 交互、学习或故障夹具效果评估。P2 没有 API/UI/模型接线，不能把仓库测试当作这些功能已交付。当前组件 schema 的保护不能追溯安装到老二进制，旧版本只能按隔离兼容副本流程查看；逻辑删除不等于擦除 SQLite WAL/历史页/备份字节。

## 回退

通过独立 revert PR 到 develop 回退代码；回退 P2 前程序只使用迁移前快照的独立隔离副本，不能覆盖当前业务库或 ADK 账本。保留未知派发身份与审计记录，不用恢复数据库冒充撤销外部操作。

关联：[P2 存储说明](../design/strategy-learning-storage-v1.md)、[主开发计划](../../plan/feature-strategy-learning-1.md)。
