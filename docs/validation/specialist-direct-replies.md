# 专员直接回复验证

2026-11-06。用户要求去掉专员对话中“Pilot／补充要求”的内部转述，直接呈现专员回复。

实际测试及签名 Dev 源码：`d5245ca5f22885f6c12ad6b5b2f8f5d29841aca2`，构建时干净；后续仅增加本文。本批基于 `origin/develop@624a49d5` 创建工作分支，为保留已安装 Dev 行为快进至 [PR #186](https://github.com/Clean-Lakes/Lake/pull/186) head `b06fa9c5`（同时包含 #185），只增加显示层修复。

## 行为

- 按持久 `message.dispatch` 元数据隐藏内部派单和补充消息，专员频道不生成空记录容器。保留原有转发去重，避免重复展示 Pilot 来源的用户输入。
- 用户直接发送给专员的消息、专员实际回复、资源引用、审批/问题继续显示。普通正文提到 Pilot 不会被关键词过滤。
- 原始消息、派单元数据、任务与执行上下文保持；未改后端路由、权限、操作或验收。旧历史在重新显示时同样生效。

## 验证结果

- `pnpm --dir web-agent test:frontend`：652/652；更新已有频道测试，检查首次派单/后续补充均隐藏，直接输入和正常回复保留，原始记录没有改变。
- `pnpm --dir web-agent build:web`：TS 类型检查及生产构建通过，仅有既有 bundle-size 提示；`git diff --check` 通过。
- `scripts/build_lake_desktop.sh --dev --ts-candidate --install`：签名构建及安装通过，`codesign --verify --deep --strict` 通过；`build-origin.json` 记录上述 SHA、dirty=false、typescript。
- 正常停止 Dev 并备份应用/Home 至私有 `~/.lake-dev-backups/specialist-direct-replies-20261106-102346/`，随后重开 `~/Applications/Lake Dev.app`，数据仅 `~/.lake-dev`。
- 原生 Lake Dev 的实际运维专员历史中，截图对应的首次派单和“补充要求”均不再展示；两段原检查结果与随文资源引用保留。原频道 API 仍返回 50 条原记录，其中 4 条含 dispatch，确认没有删除来源。
- `ego-browser` 复核当前 Dev 实际频道的深色样式与 900×820 窄窗：documentWidth=900，无横向溢出，内部转述节点为 0，正文/输入区裁切与圆角正常。只在浏览器测试页投影深色 CSS，没有修改原生应用主题偏好。

本次未发送模型要求或主机命令；未修改正式 Lake、正式 Home，未运行 Windows 原生验收。回退可恢复备份 Dev，或回退本批前端提交；原始派单记录一直保留。
