# Agent SDK 分层记忆验证

命名说明：本文路径和协议名称已映射到当前 TypeScript 后端；历史提交 SHA 保留，原始命令与输出以对应提交为准，此映射不表示重新执行历史验证。


日期：2026-11-06。本批实现基线 `develop@624a49d5`。实际自动验证及已安装 Dev 的源码为 **`0ba23164335a78be966a9034b6b6aeefa3cf9388`**，构建时工作区干净；后续提交仅补充文档。为保留此前已安装的 Pilot 修复，候选包含 [PR #185](https://github.com/Clean-Lakes/Lake/pull/185) head `cb24a624a83d6dbe364a6ff694745dd156243806`。这只建立候选依赖，没有合并或修改该开放 PR。

交付 [PR #186](https://github.com/Clean-Lakes/Lake/pull/186)，目标 `develop`，当前未合并；工作分支和 worktree 为开放 PR 保留。

## 已完成的自动验证

- TS 类型检查与 Web 生产构建通过，保留既有 bundle-size 提示。
- 后端 `node --test runtime/typescript/server.test.cjs`：67/67，无跳过。新增原生提取、跨 Session/Task 召回、真实 child 工具回执回流、单轮忽略、遗忘及原生后台失败不发布/不重派。
- Memory 宿主回归：16/16，覆盖准确 RoleID、同名和跨项目隔离、开关/来源/资源/hash 变化、更正/遗忘、迟到发布、unknown、只读失败、符号链接、凭据、模型端点变化、恢复清理和前驱任务摘要撤回。
- `tasks.test.ts/activity.test.ts/assets.test.ts/superagent-lifecycle.test.ts`：38/38；`router-context.test.cjs`：8/8，保留 #185 的调度和复查行为。
- 前端 `pnpm --dir web-agent test:frontend`：652/652。原 Go Memory 入口继续保持兼容；TS 按 bootstrap 能力选择新组件。
- Dev 路径/来源保护 `python3 -m unittest discover -s scripts -p 'test_dev_*py'`：16/16。
- ADK runtime boundary 检查通过；未修改上游 Agent SDK，未放宽完整迁移门禁。

原生记忆集成使用本地合成 OpenAI 服务，真实运行固定 Agent SDK 3.17.2 AgentRuntime 和原生 Extraction。子任务实际读取临时工作区文件，再通过原目标账本进入角色来源。协议与权限通过不代表真实模型长期记忆质量已验收。

## 合成界面验证

`ego-browser` 操作临时 Home 的实际 TS HTTP API 和生产 Web：

- 项目/用户/专员范围选择，数据库专员没有继承运维专员笔记；键盘 End/Enter 可切换范围。
- 明确保存用户偏好、更正角色笔记，来源页更新为版本 2；保存后焦点回到入口。
- 遗忘确认与取消，取消后焦点回到原遗忘按钮；最终删除行为由 API/原生集成测试覆盖，未通过浏览器删除用户资料。
- 浅色 1512×900 和深色 900×850 检查；900px 时 documentWidth=900，弹窗左右边界 24/876，圆角、焦点、下拉和内容裁切正常。
- 截图只含虚构数据：[浅色角色知识](light.png)、[深色窄窗](dark-narrow.png)。

## 签名 Lake Dev 原生验证

- macOS arm64，经 `scripts/build_lake_desktop.sh --dev --ts-candidate --install` 完成签名、ZIP/DMG 构建和 Dev 安装；`codesign --verify --deep --strict` 通过。持久身份为 `Lake Local Development Code Signing`。
- 安装位置 `~/Applications/Lake Dev.app`，数据 `~/.lake-dev/web-agent`；实际 bootstrap 返回 `backendRuntime=typescript/upstreamVersion=3.17.2/memoryEngine=typescript-layered/recoveryReadOnly=false`。
- `build-origin.json` 为上述干净 tested SHA；已安装后端 SHA256：`6e7cf694421797a573ae34562173e28082fbc342546d608d69ae3ea1a1b29624`。
- 正常停止旧 Dev 内核后备份应用及 Home 至私有 `~/.lake-dev-backups/typescript-layered-memory-20261106-101510/`，安装前验证旧 Dev 源提交属于本次候选祖先。
- 原生设置核对项目和四位专员（共用户/项目/角色六个范围），键盘切换至准确运维专员。当前 **HexHub 服务器** 项目及其角色的积累、使用开关均已开启并持久保存（revision 2）；没有开启其他项目或用户全局自动采集。
- 原生浅/深主题复核圆角、焦点、文本与裁切；恢复原“跟随系统”主题偏好。窄窗 900px 的有内容交互由上面的合成浏览器验证覆盖，没有把它写成原生 900px 检查。
- 开启后 `memoryJobs=0/memorySources=0`，确认没有扫描旧历史；重启前后任务/会话/终端状态计数一致，没有自动重派任务。

## 证据边界

原生 Dev 复核没有发送真实供应商的提取请求，原生模型协议闭环由前述合成供应商集成测试覆盖。未执行 Windows 和真实供应商长期质量集；旧 Memory 数据没有自动迁入，正式 Lake/Home 未操作。用户层只有明确保存和使用入口，没有自动跨项目采集；聊天中的更正/遗忘仍需转到设置完成，不能冒称操作成功。完整 TS 后端功能等价验收仍未通过，本批不扩大默认/正式后端切换范围。
