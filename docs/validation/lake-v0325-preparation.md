# Lake v0.3.25 兼容性发布准备

日期：2026-11-03。**状态：准备中，未发布；生产旧安装尚未修复。** 用户仅授权准备兼容性发布，不授权直接合并、创建生产PR、安装或重启生产。

## 来源与实际范围

| 对象 | 已核对的状态 |
| --- | --- |
| 当前正式Release | v0.3.24，2026-10-30发布，target master |
| master | `b921d078044ef5cc0616970a4726fc15039e413e` |
| develop基线 | `2b233a4ad9d405e5b7bf4705359303b31bcde652` |
| 准备分支 | `sync/v0.3.25-preparation`，从上述develop建立 |
| 历史同步 | `c03e0b39a19920265398c4d01ea04f8250e6323a`仅在短分支merge master，文件树与develop相同；准备PR必须保留此merge祖先 |
| 下一版本 | 0.3.25，macOS arm64；v0.3.25标签在开始准备时不存在 |
| PR #142 | 未合并；长期角色频道、任务隔离/比较、执行修复及近期停止/加载/确认提示尚不属于本准备基线 |
| PR #143 | 未合并；标题宽度修复与#142部分重叠，整合前须核对最终diff |

兼容修复`c42c96f2`已经通过PR #141进入develop。`internal/ai/security_migration_finalize.go`、`security_store_migration.go`、`security_risks.go`与当前已安装Dev来源`86031db7`逐文件一致；无需复制另一套reader。基线相对master是54个develop侧提交（含合并）和363个变更文件，包含Security任务、恢复、安全只读核查、Super-agent内核及相关UI；不能描述为仅变更兼容读取的小补丁。

## 故障与保留边界

备份清理时使用新CLI完成生产Home迁移收尾，canonical回执完整，历史归档已删除。已安装的旧0.3.24缺少format2 reader，启动迁移路径会拒绝该清单。`security status`读取成功不证明旧程序可以正常启动。

生产原133条操作、5条unknown与原数据保留；Dev93条旧unknown保留，C4仍completed/pass，未因收尾代替源任务验收。此次准备不再次操作两个真实Home，不复制生产凭据，不重新删除备份，不改gate或结果。需要另行授权的兼容版本正式安装才能核实生产恢复。

## 准备检查

详细命令、被测SHA、包摘要及结果写入[机器记录](lake-v0325-preparation.json)。本节只记录已经完成的检查；在候选冻结前不宣称正式候选验证通过。

## 发布顺序与未完成门禁

1. 审阅本准备PR与#142/#143的准确head及范围；取得对应合并授权后，经GitHub PR进入develop。准备PR用merge commit保留master生产历史，不squash历史同步。
2. 根据最终选定范围补齐macOS说明，冻结实际develop SHA。当前已安装Dev是后续功能分支，不可把它直接标为本发布候选；旧基线也不能覆盖日常Dev。
3. 在最终SHA运行全量Go、相关race、vet、ADK/Security边界、前端类型/测试/构建和签名Dev验收。明确验证format1升级、format2无归档启动、凭据损坏拒绝及旧unknown防重；核对原项目/资源/原任务记录。
4. 取得创建生产PR授权后，创建同仓库develop→master PR。必需CI、独立评审及生产合并授权完成后以merge commit合入；不能用准备包或当前分支测试替代最终CI。
5. 取得发布、安装/重启的对应授权后，从干净origin/master制作正式签名包、校验SHA与证书、发布到master渠道，再验证真实生产就绪与原账本。当前未执行以上生产操作。

Windows不在本次目标平台；不更新或复用旧Windows说明来声称有0.3.25包。日常Dev继续运行现装`86031db7`，本准备包仅为未安装的Dev格式验证产物，不能上传为正式资产。

## 回退与失败处置

- 安装前必须另行授权并保全当时的完整当前配对数据；它保护升级后回退，不用于伪造已删除的旧迁移归档。
- 如果候选启动失败，停止新派发，保留数据库、control、清单、收尾回执、原操作和未决状态；收集脱敏诊断后使用保留format2及当前schema reader的兼容修复向前处理。
- 旧安装程序可能在更新失败时回滚应用二进制；它不能读取当前format2数据，因此自动恢复旧应用不等于服务已恢复。不得声称本次存在可工作的0.3.24降级路径。
- 禁止手工降清单、删receipt/control、放松校验、恢复旧授权、用旧库覆盖新增操作或重放unknown。没有可用兼容候选时保持停服并报告具体错误。

实施任务与授权边界见[发布计划](../../plan/process-compatibility-release-1.md)。
