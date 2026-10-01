# 去敏迁移样本

`v01.db` 到 `v16.db` 是按 `lake/store/schema.go` 逐级生成的 SQLite 数据库。它们只包含虚构的湖、`example.invalid` 主机、不可用的凭据引用、旧会话、旧 `SpecialistCall` 和只读工作流；没有 API Key、私钥或真实端点。

运行 `go test ./lake/store -run 'TestMigrationFixturesV1ThroughV16|TestFailedUpgradeKeepsRestorableV15Snapshot' -count=1` 可逐版本验证升级到当前 v17 schema（包括早期事件表缺列的修复）、重复打开、权限不扩大、旧工作流执行和失败后的私有备份。修改历史迁移定义后，需先审查兼容性，再显式运行 `LAKE_UPDATE_MIGRATION_FIXTURES=1 go test ./lake/store -run '^TestGenerateMigrationFixtures$'` 重建样本；不要把用户数据库作为测试样本提交。
