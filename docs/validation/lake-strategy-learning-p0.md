# 策略学习 P0 本地验证记录

日期：2026-10-20。平台：macOS / darwin arm64；Go：1.26.6。工作分支：`codex/strategy-learning-p0`；起点及核对后的 `origin/develop` 均为 `de6ddebc8cb6ba752f070250581688250001b1f5`。实际提交 SHA 在本次 PR 的验证证据中记录；下列源文件 hash 固定被测内容。

状态：本地契约检查通过，等待开发评审采用 P0 契约；T02 尚未通过评审门禁。本文不代表应用功能、模型效果或可运行故障夹具验收通过。

## 验证范围

- 核对现有 Web/Desktop、stdio、SRE、Skills、记忆与实际 provider 请求调用链，完成固定规则/策略/上下文分类。
- 新增独立 `internal/strategy` 值对象及结构校验，包含范围、默认全关设置、预算上限、不可变版本和来源引用；没有生产代码引用此包。
- 选择 15 项案例规格：12 项开发、3 项保留，明确 baseline / assets / assets_with_correction 三臂及复位、边界、验收条件。
- 更新主计划，保留 P1～P8 未完成状态；数据库、API、界面、ADK 运行循环和现有提示词均未修改。

## 本地命令及结果

| 命令或检查 | 结果 |
| --- | --- |
| `go test -race -count=1 ./internal/strategy` | exit 0；`ok github.com/Clean-Lakes/Lake/internal/strategy 1.747s` |
| `go vet ./internal/strategy` | exit 0，无诊断 |
| `python3 scripts/check_adk_runtime_boundary.py` | exit 0；production entrypoints and provider-call AST checks passed |
| `go list -f '{{join .Imports "\n"}}' ./internal/strategy` | 仅 crypto/sha256、encoding/hex、errors、strings、unicode/utf8 五项标准库依赖 |
| 生产 Go 文件搜索 `internal/strategy`（排除新包） | 无导入或引用；当前应用没有接线新契约 |
| `gofmt -l internal/strategy` | 无输出 |
| `git diff --check`、暂存区 whitespace 检查 | 无错误 |
| 本次三份 Markdown 的相对链接、代码围栏 | 目标存在，代码围栏闭合 |

测试覆盖默认关闭与 JSON 往返、范围歧义、revision/epoch 组合、缺失/超限预算、零附加重试语义、正文精确字节 hash、版本父引用、来源去重、UTF-8/长度边界，以及案例 manifest 的字段/划分/覆盖/禁止效果声明。来源实际存在性与授权不是值对象可以证明的内容，后续由宿主实现。

## 被测源文件 SHA-256

```text
84d9fe5c285ed385b73861dd20b92003b53effaed21f9a444b765721abb83eed  internal/strategy/cases_test.go
43233cec15ca89429c44e34b286d983b5c24570fa9e76ac5419d03714ff59503  internal/strategy/contracts.go
aaa65cf6b40c3e6cb2f85f14ec9f8d88338f5a5e199f16ab6f6de95c48d7f09a  internal/strategy/contracts_test.go
1b96c6e9acaf4c47b010e9d7fc5eb606b005b41638ca81fec67ff9f31a04a738  internal/strategy/testdata/cases.v1.json
```

## 未验证项与后续门禁

未运行全仓库 Go 回归、前端检查、Windows 验收或 Lake Dev 重建/安装：本次新增包独立且未被应用引用，未改变对应运行路径。未连接真实模型或资源，未实现夹具镜像/复位脚本，未运行三个实验臂，因此没有学习收益或排障成功率数据。保留集标准不能复制到提案/执行模型上下文。

开发 PR 按现行规则不自动运行 CI，本次也未请求手动工作流。没有 CI 结果不能替代本地证据。待评审通过再冻结 T02；P1 首先建立各 profile、SRE 角色和 workflow/stdio 在关闭状态下的黄金基线，随后实施组合器与清单。

不涉及数据库迁移、外部副作用或权限变更。需要回退时，经独立分支向 develop 提交 revert PR；不直接更新长期分支。

关联：[P0 契约](../design/strategy-learning-contract-v1.md)、[主开发计划](../../plan/feature-strategy-learning-1.md)。
