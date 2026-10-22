# Lake 行内对象引用验证

日期：2026-10-22。方案：[feature-inline-object-references-1.md](../../plan/feature-inline-object-references-1.md)。PR 从 `origin/develop` 的 `51d378c8` 隔离适配，不包含原工作区中的其他未提交修改。

## 实现范围

- 普通回复、历史 assistant 消息、终端会话、SRE 正文及子任务结果复用 `AssistantMarkdown`。
- 当前项目唯一资源名称与完整地址绑定真实资源 ID；同名、共用地址和跨项目资源不猜测。软件及版本、明确文件路径、本轮文件变更和已命名任务使用对应标签。
- 资源复用现有 `ResourceIcon`、无边框类型配色、22px / 11px 曲线；软件标签使用中性淡底色。正文和标签常规字重，表格无框线，最终正文不自动折叠。
- 资源点击展示白名单只读详情；文件预览使用已保存的会话变更；软件与未知路径不提供假跳转。点击标签不执行操作。
- 保留 develop 现有代码块复制、提交号复制、显式信息字段、文件链接及过程记录归档，不修改消息、模型、权限或持久化协议。

## 验证命令

使用 Node.js `v24.19.0` 和 pnpm `10.33.4`，无新增依赖：

```sh
pnpm --dir web-agent check
pnpm --dir web-agent test:frontend
scripts/build_lake_desktop.sh --dev
codesign --verify --deep --strict 'dist/macos/0.3.21/arm64/dev/Lake Dev.app'
python3 scripts/check_adk_runtime_boundary.py
git diff --check
```

适配后的 397 项前端测试已通过，包含 11 项新增引用与共享渲染回归。最终提交 SHA、重新验证结果及签名构建结果记录在 PR 的验证证据中。

## 浏览器实测

使用 ego-browser 检查隔离的 `/test/fixtures/object-references.html`；页面无后端、模型或凭据请求，对象与地址均为演示数据。[机器可读结果](lake-inline-object-references.json)。

- 软件标签高度约 `22.17px`，资产标签 `22px`；全部字重 `400`，资产边框 `0px`、圆角 `11px`。
- 表头与单元格边框 `0px`，字重 `400`。
- Enter 打开资源详情，Escape 关闭后焦点返回原标签。
- 文件引用可以打开会话保存的 `nginx.conf`，命令仍作为代码保留，未执行命令。
- SRE 展示相同的 4 个引用标签，字重一致。
- 真实 iframe 布局视口 `390px`，页面宽度 `390px`，无横向溢出；240 个汉字的长标签保持省略且页面不撑宽。

截图：[数据库对比](lake-inline-object-references-light.png)、[故障排查](lake-inline-object-references-service.png)、[深色](lake-inline-object-references-dark.png)、[窄窗口](lake-inline-object-references-narrow.png)。

## 未验证项

未覆盖当前安装的 Lake Dev。原工作区的 `--dev --install` 被来源提交保护拦截，已安装应用包含当前原工作区没有的提交 `5443ea772150`。本 PR 保留该保护，不更改其来源记录、不覆盖应用、不操作生产数据。签名构建与隔离浏览器检查不等同于桌面安装验收；正式合并前仍需 Lake Dev 集成确认。
