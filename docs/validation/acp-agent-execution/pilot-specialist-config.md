# Pilot 自然语言专员配置验证（2026-11-11）

已测试源码与签名 Lake Dev：`afbfe85ed6cff7c1d30a4e48c70d76a64559f1a9`，macOS arm64，固定 Node 24.14.0。实施见[计划](../../../plan/feature-pilot-specialist-config-1.md)，结构化证据见[验证 JSON](pilot-specialist-config.json)和[浏览器记录](pilot-specialist-config-browser.json)。

## 原因与行为

原 `manage_specialist` 只有名称和职责，更新还要求同时提交两项；前端头像完全由 RoleID 分配。将“角色用河狸”写进职责不会改变图形，也没有可保存的头像字段。

现在 Pilot 可以创建、读取并局部更新专员的名称、职责、本地头像和后续任务默认 Agent。`list_specialist_avatars(query?)` 查询与前端共用的 100 项图形，中文名/别名/英文 ID 优先精确匹配，再做包含查询；河狸、海狸及 🦫 对应 beaver。`avatar_id=auto` 恢复原 RoleID 图形。未知 ID、URL 和任意 SVG 不作为头像载入。

更新只提交改动字段，未提交配置保持；创建仍要求 name/duties，未指定职责时可保存空字符串，不从动物外观编造工作职责。默认后端仅支持当前 native/Codex，复用原 registry 校验；不修改本机 Codex 模型、登录或思考设置。原后端选择 API 继续兼容带 profile revision 的引用，不将该版本保存为新任务绑定。

管理沿原人工 event/quote、项目准确 RoleID、expected_revision、事件/part 幂等事务。角色、频道和任务身份保持。名称、职责与后端仍在任务创建时冻结；当前显示头像经共享 Provider 更新侧栏、标题、任务与 Pilot 报告，不改写旧 Worker 或执行事实。无显式头像的旧配置保持原分配顺序、配色、相位和动作。

## 检查

| 检查 | 命令或操作 | 结果 |
| --- | --- | --- |
| 后端类型及构建 | `tsc --noEmit -p runtime/typescript/tsconfig.json`、`node runtime/typescript/build.mjs` | 通过 |
| 后端单元 | `TSX_TSCONFIG_PATH=runtime/typescript/tsconfig.json <Node24> --import ./web-agent/node_modules/tsx/dist/loader.mjs --test runtime/typescript/*.test.ts` | 275 通过，4 项既有可选跳过 |
| 宿主集成 | `<Node24> --test runtime/typescript/server.test.cjs` | 199 通过 |
| 固定真实 Codex ACP | 固定 adapter 2.2.2 / engine 0.160.1 + 本地合成 Responses | 4 通过，无真实外网推理 |
| 前端 | Web 类型、全量单元及 Vite 构建 | 通过 / 799 通过 / 通过；签名脚本再次构建通过 |
| 边界及命名 | runtime boundary、backend naming 及 Python 单元 | 通过 / 0 违规 / 5 通过 |
| 浏览器 | 完整 App + 虚构 API，浅色 1100px / 深色 620px | 同角色各处为河狸，其他角色保持；auto 恢复原图形，头像外层节点/相位稳定，草稿及继续输入正常，无横向溢出 |
| 签名 Dev | `scripts/build_lake_desktop.sh --dev --install` | 正常退出旧内核后安装；准确 SHA、dirty=false、Dev bundle ID、后端哈希、深度签名及实际进程路径通过；原 Pilot 正常加载且输入可用 |

新增宿主场景通过真实 SDK 发起目录、创建、局部修改和恢复 auto 工具调用：两段中文测试输入保存河狸与狐狸，并设置后续 Codex；名称/职责保持，RoleID/频道不变。重启后头像和 mutation 记录保持，恢复 auto 仅清除显式头像，整个流程零 Worker/goal。模型响应来自合成本地服务，不能据此宣称真实外部模型的意图识别可靠性。

单元进一步覆盖未知字段/头像/后端、失效版本、跨项目和未接纳原文的原子拒绝；同 part 重复不递增版本、参数冲突拒绝；已有任务职责及执行快照保持。前端集成覆盖同一 RoleID 的导航、报告、任务详情及 Pilot 固定头像，项目切换或未知旧值安全回退。

## 图形与交互

截图使用虚构展示数据：[浅色河狸](pilot-config-beaver-light.png)、[深色窄窗](pilot-config-beaver-dark-narrow.png)、[任务详情](pilot-config-beaver-inspector-dark.png)。外层节点保持，八行任务与标题、侧栏及详情使用同一图形；其他角色不跟着改变。Pilot 草稿在头像配置刷新后仍保留焦点并可继续输入，无业务消息/上传写入。Ego 的 editable 点击包装器报告 disabled，DOM 实际可编辑且不 inert，改用键盘聚焦与输入验证；没有将该包装器失败记为鼠标通过。浏览器空间及 Vite 已结束。

## Dev 数据与范围

安装前无活动 Worker、频道、Router、ACP 或 running 命令。安装后逐条哈希核对：19 个项目、151 个可见 Worker；20 条角色、17 条频道、4 条角色变更；129 条 TS Worker、129 条目标、183 条尝试、400 条操作、162 条验收、175 条报告、5 条 ACP、287 条命令及 14 类共 689 条 legacy 记录保持不变。本机 Codex 配置全文哈希一致，继续继承 max。

真实 Dev 仅只读核对；配置写入回归在隔离测试中进行，原专员、任务及失败请求保持。只保存小型私有哈希审计，没有新建完整 Home/数据库副本；此前删除的四处备份根目录未重建。正式版未安装或重启，无自动 CI、合并或发布。

本轮范围是专员配置，不包括凭据及全局安全策略的自然语言编辑。其他平台、Go/race/vet 和完整迁移等价未重测，原 Vite chunk/Swift build-system 提示保留。新增配置为可选 JSON 字段，不做历史头像推断或 schema 迁移；代码回退时旧 UI 使用原自动图形，保留存储与业务记录，不回灌旧库。参见[兼容记录](compatibility.md)。
