# 旧策略资产完全退出验收

基线：develop `360fc7d738112c9ecf9025460551fac3f6053fcb`。退出阶段验收代码 `b071abf3fd325bac5c139dcba35ffa14f56a0a96`；该阶段后补测试支持包 keyed literals 和验收附件。之后的记忆设置界面整理另见[界面验收](memory-settings-clarity.md)，以下保留退出阶段的实际结果。新行为、归档与回退要求见[退出契约](../design/legacy-asset-exit.md)。历史 C4/N1 验收只解释当时版本，汇总见 [checks.json](legacy-asset-exit/checks.json)。

## 本地检查

| 检查 | 实际结果 |
| --- | --- |
| `go test ./... -count=1 -timeout=8m` | 通过，AI 46.505s、Web 210.794s，含单独历史测试支持包 |
| 退出与兼容工具 | 418 项通过、6 项明确跳过、0 失败，包含子测试；不是模型收益验收 |
| race | AI 全包通过；Web 本次改动覆盖组修复后通过（29.933s），详见下述运行记录 |
| `go vet ./...`、ADK AST 边界 | 通过；禁止产品导入测试支持包或恢复旧注入/provider/变体执行入口 |
| 前端 | 类型检查、532 项测试和构建通过 |
| Python 工具 | 兼容报告 4 项、消息等待 5 项通过 |
| Windows | 后端和客户端测试交叉编译通过；未运行原生 WebView2/ACL 验收，未派发 CI |

race 首次 Web 整包触发 5 分钟总时限。扩大整包时限后，609 项（含子测试）通过，发现一个新测试桩对通道变量重赋值的数据竞争。已改用 `sync.OnceFunc` 关闭固定通道；随后用 `go test -race ./internal/web -run 'TestLegacy|TestRetired|TestStrategy|TestNaturalMemory' -count=1 -timeout=3m` 通过。本次没有将修复前失败的整包命令宣称为通过，也没有将未重新运行的完整 Web race 计为通过。

回归覆盖认证/项目可见性后的旧路由全部 410、旧回执不能复活写入、跨轮次无旧注入、旧设置请求不取消普通任务、v6 精确资产/N1 映射迁移、原设置归档关闭、不隐式形成偏好、重复启动、失败事务回滚、来源撤回、私有只读导出/不覆盖/取消/符号链接边界。

新自然偏好的形成、范围、使用、撤销/遗忘、后台整理、压缩捕获、审批、未知操作与 ADK 恢复回归保留。旧正向管理/注入验收由退出用例取代；原 schema/hash、未知作业/用量和来源撤回回归保留。旧数据构造和历史格式辅助代码只在测试文件或 `internal/testsupport/legacystrategy`；`go list -deps ./cmd/lake` 确认产品无测试支持包依赖。

## 签名后端与工作库升级

使用 `scripts/run_lake_dev.sh` 运行签名后端和新 Web 资源；没有打包、发布或变更生产应用。运行前正常退出 Lake Dev，对 `~/.lake-dev/web-agent/lake-web.sqlite` 和 `adk/sessions.sqlite` 做 SQLite 一致备份。

工作库的 8 个旧资产全部归档，6 条自然偏好保持不变。53 张基线表中 49 张逐行 hash 不变；其余仅为预期的 strategy schema marker、旧设置、scope generation 和退出审计事件。原设置完整行与设置档案一致，旧开关全部关闭。ADK 历史纠错和请求清单逐行 hash 不变；两库 integrity_check 均为 ok。另在 Dev 私有 exports 目录显式导出一份包含 8 项资产的私有档案，正文未加入仓库。

最终产品代码的隔离验收从停机合成 v6 数据升级：精确正文、N1 映射和未知调用身份保留，旧开关关闭、不生成自然偏好；重启不重复迁移；两次实际 HTTP/ADK 请求均无旧正文、纠错或实验清单。指定的旧 develop 二进制在隔离副本拒绝 v7，拒绝前后数据 hash 不变，新版再打开也不变。仅使用本机合成供应商，两次模型请求，无真实收益评价。

## 实际 Dev 试用与 UI

在首次实现代码 `f0fc0b44035c4ba60ffeea224d3dd3448a3482e5` 进行了两次真实模型新会话试用，后续产品运行行为未改动：

| 场景 | 结果 |
| --- | --- |
| 「2加2等于几？请简短回答。」 | `【协调偏好】2 加 2 等于 4。`，准备的是原自然偏好准确 ID |
| 「这次只回复数字4，不加任何前缀或解释。」 | `4`，当前明确要求优先 |

均正常完成，无操作卡/新纠错，旧实验清单和纠错表增量均为 0。自动积累保持原先关闭，项目自然偏好使用保持原先开启，未改成旧 consent。

最终产品代码的真实 macOS Lake Dev 已验证：旧管理/承接入口不存在，实验标识保留，范围菜单可打开并用 Escape 关闭；明暗主题和 1003px 宽窗口的文字换行、控件、圆角和滚动正常。最后恢复浅色与原窗口宽度。

- [浅色](legacy-asset-exit/light.jpg)、[深色](legacy-asset-exit/dark.jpg)
- [浅色窄窗](legacy-asset-exit/light-narrow.jpg)、[深色窄窗](legacy-asset-exit/dark-narrow.jpg)

Windows 原生缺口继续保留；交叉编译和旧 N5 报告不能替代本次 WebView2/ACL 验收。旧结果、unknown 和不确定收益结论没有改写。
