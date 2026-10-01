# 运维回归测试

使用源码构建的 ZCode 与合成模型/主机执行器，完成测试湖 → 主机查询 → 固定只读检查 → 审批与结果 → 湖志。测试不读取生产凭据，不连接真实主机。

```sh
npm exec --yes --package=node@24.14.0 -- node scripts/build_zcode_agent.mjs
bin/zcode/node scripts/test_zcode_ops.mjs
PATH="$PWD/bin/zcode:$PATH" pnpm --dir third_party/zcode --filter @zcode/lake test
pnpm --dir third_party/zcode exec tsx --test apps/zcode-cli/packages/lake/test/native-remote.test.ts
```

`conversation.test.mjs` 覆盖实际原生 Agent / MCP / 运维服务 / 审批 / 持久化历史与湖志；`operations.test.mjs` 覆盖撤权、取消与重复派发。原生 Agent 测试覆盖 Bash、用户问题、连续会话、重启恢复及报告的只读工具范围。SSH 测试使用临时生成的合成主机身份和本地服务器，验证主机身份拒绝与两条独立 loopback 转发。

完整桌面构建验收使用 `scripts/verify_lake_release.sh`。真实远端部署与外部模型服务需要按目标环境单独验证，不计为合成测试已经覆盖。
