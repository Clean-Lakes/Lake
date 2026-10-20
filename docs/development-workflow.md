# Lake 分支与发布规范

本规范适用于所有开发者和 AI，覆盖代码、文档、配置、依赖、紧急修复及发布准备。根目录 `AGENTS.md` 是 AI 自动读取的规则入口，开始修改前必须读取本文件和 `CONTRIBUTING.md`。旧计划中“向 master 发 PR”等历史指引不再适用于日常开发。

## 分支职责

| 分支 | 职责 | 合入方式 |
| --- | --- | --- |
| `develop` | 长期开发集成、累积变更、本地 Lake Dev 验证 | 独立工作分支的 GitHub PR |
| `master` | 已完成批次验收的生产代码 | 仅本仓库 `develop -> master` 发布 PR |
| `codex/<topic>` | AI 负责的单项变更 | 从 `origin/develop` 创建，PR 到 `develop` |
| `feat/`、`fix/`、`docs/`、`chore/` 等短期分支 | 人工功能、修复、文档、配置 | 从 `origin/develop` 创建，PR 到 `develop` |
| `sync/<topic>` | 必要的生产合并历史回同步 | 从 `develop` 创建，在此分支合入 `origin/master`，PR 到 `develop` |

`dev` 指环境，长期开发分支统一命名为 `develop`，不建立并行的 `dev` 集成分支。创建最初的 `develop` 引用只是将它指向已有生产提交，是一次性初始化；此后任何更新必须经过 PR。

禁止直接向 `develop` 或 `master` commit/push、强推、删除，禁止本地合并后直接 push，禁止用管理员绕过。小修复、文档和配置也不例外。短期分支可更新，不覆盖别人未提交改动或改写他人历史。

## 日常开发

```sh
gh auth switch --hostname github.com --user bearqy
gh api user --jq .login
git status --short --branch
git fetch origin
git switch -c codex/example-change origin/develop
# 修改、检查、测试；只提交本次拥有的文件
git add -- path/to/changed-file
git diff --cached --check
git commit -m 'fix: describe the user-visible change'
git push -u origin codex/example-change
gh pr create --repo Clean-Lakes/Lake --base develop --head codex/example-change
```

这是示例，不要求重复切换账号或创建分支。先检查当前状态，已有合适工作分支可继续使用。Git 推送认证也必须使用 `bearqy`，其他应用切换了活跃账号时重新核对，不借其他存储账号获得管理权限。

PR 目标必须显式写 `develop`，即使 GitHub 默认分支尚未正确配置。历史未合并日常 PR 改为 `develop` 后，重新检查 diff、冲突、审查状态和 CI；变更 base 可能使旧审批失效，不能依据旧结果立即合并。

每项工作使用 PR 模板，说明具体行为、测试证据、未验证项、数据/权限影响和回退方法。必需检查通过、评审意见解决后才具备技术合并条件。对 AI，“开发/修复/提交/创建 PR”不包括“合并”；只有用户明确授权合并对应 PR 后才执行，不能自行开启 auto-merge。

普通 PR 可 squash，保持变更可回退；不要删除长期分支。未完成或验证失败时保持 PR 打开或草稿，不能虚构通过，也不能为了合并删除测试、跳过门禁或放宽权限边界。

## 在开发环境积累

- 按功能和风险划分小 PR，先合入 `develop` 集成验证，不等累计成大改动才第一次创建 PR。
- 日常只构建、安装、运行 Lake Dev。macOS 使用 `scripts/build_lake_desktop.sh --dev --install`，Windows 使用 `python3 scripts/build_lake_windows.py --dev`。只重启 Dev。
- Dev 与生产应用、Home、凭据分离。日常 Dev 使用 `~/.lake-dev`；自动测试使用显式独立目录。禁止复制或链接正式版 `~/.lake/secrets`。
- 功能 PR 记录实际测试的 head SHA，合入后记录 `develop` 集成 SHA；发布前对最终候选 SHA 验收，不能拿旧分支测试代替最终候选。
- Go/ADK、工具、权限、持久化和恢复改动运行对应回归及 `scripts/check_adk_runtime_boundary.py`；前端执行类型检查、相关测试和构建；原生平台差异在目标平台验证。
- 纯文档或流程变更验证格式、链接和规则行为，注明应用测试未运行。CI 包是测试产物，不自动成为 Release，也不能覆盖生产安装或接入稳定更新渠道。

## 批次发布

不按固定 PR 数量自动发布。用户决定何时将一个批次提升到生产，至少满足：功能边界可交付、最终集成验证通过、关键问题已列明、迁移和回退可执行。

1. 从 `origin/develop` 创建发布准备分支，经普通 PR 将 `VERSION`、对应平台发布说明、累计变更和最终验收材料合入 `develop`。
2. 用户明确授权后创建 **本仓库 `develop -> master`** 发布 PR，记录最终候选 SHA、平台结果、已知问题、迁移和回退。冻结候选期间不再合入新功能；若 `develop` 更新，重新验收并更新 PR。
3. 发布 PR 必须通过分支策略和必需 CI，并取得至少一位合格独立评审（保护启用后强制）。用户明确授权生产合并后使用 **merge commit**，保留开发分支祖先关系；发布 PR 禁止 squash/rebase。
4. 合并不自动发布。取得本次版本的发布授权后，将本地 `master` 快进到 `origin/master`，从干净工作区使用签名构建和现有发布脚本。只从生产提交创建正式标签/Release；Dev 构建不能上传成稳定包。客户端稳定渠道继续使用 `target_commitish=master`。
5. 若生产合并历史需回同步，从 `develop` 创建 `sync/<version>`，在该分支合入 `origin/master`，通过 PR 回到 `develop`。此 PR 使用 merge commit 保留生产合并提交的祖先关系，不直接推送长期分支。

创建发布 PR、生产合并、发布脚本、`v*` 或 `lake-*-assets-*` 标签、Release 上传/发布、生产安装/重启都需对应明确授权。CI、规范和模型推断不代替授权；本次建立流程不等于批准发布新版本。

## 紧急修复

紧急程度不构成直推理由。优先从 `develop` 创建修复分支，经 PR 集成验证，再批次提升。若 `develop` 已包含不能发布的改动，暂停生产提升，由维护者明确隔离方案；批准专门流程前不能向 `master` 直接提交 hotfix、挑选提交或绕过来源检查。

## GitHub 强制约束

文档和 AI 指令负责行为约束，防止绕过需要 GitHub 服务器保护。默认分支推荐设为 `develop`；两条长期分支都启用保护：

| 配置 | develop | master |
| --- | --- | --- |
| 必须 PR | 是 | 是，且只能同仓库 develop 提升 |
| 必需检查 | `branch-policy`、`workbench` | `branch-policy`、`workbench` |
| 与目标同步 | 是 | 是 |
| 管理员也受约束 | 是 | 是 |
| 强推/删除 | 禁止 | 禁止 |
| 未解决讨论 | 必须解决 | 必须解决 |
| 最少批准数 | 0（仍必须 PR/CI，AI 合并须用户授权） | 1，撤销过期审批，最新推送者不能批准 |

可按团队人数提高 develop 批准数。路径过滤的 Windows/ADK 检查按改动运行，不能直接设成所有 PR 必需，否则未触发的检查可能一直等待。GitHub 无法识别本地聊天授权；AI 的合并/发布授权由 `AGENTS.md` 约束，评审通过不等于用户授权。

分支来源检查使用 `pull_request_target`，仅检出受信集成分支 `develop` 的检查脚本、仅读取事件元数据，不执行 PR head，不使用写权限或检出凭据。对生产 PR 也使用受信 develop 规则，避免首次治理同步时 master 尚无脚本。该检查需配置为 required check；单有工作流不等于已保护分支，也不能阻止仓库管理员修改保护本身。

管理员在治理 PR 经标准 PR 合入 develop、检查上下文可用后配置：

```sh
gh api --method PATCH repos/Clean-Lakes/Lake -f default_branch=develop
gh api --method PUT repos/Clean-Lakes/Lake/branches/develop/protection \
  --input .github/branch-protection/develop.json
gh api --method PUT repos/Clean-Lakes/Lake/branches/master/protection \
  --input .github/branch-protection/master.json
```

JSON 与代码一起评审。必需检查固定为 GitHub Actions App，配置前通过当前 check runs 核对名称与 App ID，未来更名同步保护。没有管理员权限时明确标为未启用；404/无法读取不代表保护存在。

## 初始化和存量迁移

1. 初始 develop 指向当前 master 已有提交，没有合入额外功能。
2. 治理变更先在短期分支创建 PR 到 develop；不为引入规范而直接推送长期分支。首次治理 PR 的本地规则验证随 PR 提交，不假定其尚未安装的门禁已经运行。
3. 所有未合并日常 PR 改为 develop，重新检查 diff 和 CI；已合并 PR 保留历史。
4. 管理员配置默认分支 develop。治理工作流存在于受信分支后，确认 `branch-policy` 在 PR 中真实出现，再将其加入必需检查；不配置一个永远不会触发的检查。
5. 后续经用户授权创建 develop 到 master 的治理同步 PR，让 master 获得规则。这个 PR 只同步治理，不自动改版本或发布。若工作流尚未在某个 base 触发，先由管理员核对 GitHub 首次安装顺序和实际检查列表，不删除保护强行合并。

服务器设置、治理合并、生产同步分别记录实际状态，不把“文件已经写好”当作“规则已在所有分支生效”。首次初始化后不再允许引导例外。

2026-10-20 初始化状态：develop 创建于 master 已有提交 `57e5a80`；`bearqy` 的权限查询为 Maintain、非 Admin。修改默认分支及两条分支保护的 API 请求均返回 HTTP 404，未启用服务器强制约束。治理文件需通过本次 PR 合入，随后由管理员按上文配置；本条是初始记录，后续将实际合并和启用证据追加在此，不改写为未经验证的完成状态。

实现依据：[GitHub 官方事件说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target)。`pull_request_target` 读取默认分支工作流；只有治理工作流进入默认分支后才会触发。检查本身不检出 PR head，保持只读权限。

## 日常检查清单

- 修改前：账号、工作区、最新 origin/develop、根 AGENTS、本文和目录约束。
- 提交前：改动范围、秘密、必要测试、Dev 隔离及验证 SHA。
- 创建 PR：普通目标 develop，发布来源 develop，模板和证据完整。
- 合并前：CI、评审、讨论、明确用户授权；无直推或绕过。
- 发布前：最终候选、生产 PR、版本/说明、回退及发布操作授权。
