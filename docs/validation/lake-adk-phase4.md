# ADK C0 验证记录

- 分支：`experiment/adk-runtime`
- 日期：2026-10-18
- 状态：C0 完成；C1/C2/C3 未开始

## 完成内容

- 新增 `internal/ai/sre_host.go`：
  - `SREHost` 接口：`BuildSREPlan`、`RunSRERole`、`EvaluateVerification`、`SRERepository`。
  - `Engine.BuildSREPlan` 包装现有 `buildSREPlan`。
  - `Engine.SRERepository` 暴露持久化边界。
  - 编译期断言 `var _ SREHost = (*Engine)(nil)`。
- 行为不变：现有 Go SRE 引擎仍是唯一执行路径。

## 验证

```bash
go test ./internal/ai ./internal/web -run 'TestSRE|TestADKRuntime'
```

通过。C0 不改变任何 SRE 行为，只是给 ADK graph 提供稳定依赖边界。

## 未完成

- **C1**：ADK graph 只读切片（coordinator → investigator → verifier），与 Go SRE 双跑。
- **C2**：executor/审批/验证/暂停恢复 parity。
- **C3**：删除 `Engine.ChatTurn`、`multi_agent.go`、旧 SRE 编排。

## 结论

C0 完成，但没有删除旧 runtime；C1 才是第一个可运行的 ADK SRE graph，需要独立实现和验收。
