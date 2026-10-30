# 空草稿光标位置验收（2026-10-30）

修复代码：`56c0da9b5387b2fbb7d5c57c080aebc128ee6075`，从 develop `9d1c4c65` 独立开发。输入框为空且出现不可编辑的补齐建议时，原来的选区只能落在元素边界；占位伪元素还参与行内排版，WebKit 可能把光标绘制在输入框最右侧。

## 变更与验证

空草稿和末尾引用共用已有的标记零宽编辑锚点，位于建议前；占位提示不参与行内宽度。辅助建议节点更新完毕后恢复真实草稿选区，同一建议不重复移除/挂载。鼠标或键盘把选区移到提示后时，规范化到可编辑文本落点，组合输入期间不干预。

- `pnpm --dir web-agent test:frontend`：551/551，通过两次（独立修复与 Dev 集成）；新增空稿/补齐下的选区映射与锚点不入载荷回归。
- `pnpm --dir web-agent check`、`build:web`：通过。既有大 chunk 提示仍在。
- ego-browser 使用真实 App 的虚构数据夹具 `/test/fixtures/composer-caret.html`：修复前折叠 Range 的绘制矩形为零；修复后空稿及点击最右空白后，光标 x=431，与编辑器左边界 x=431 相同，行框高度 16.5px。
- 普通连续中文文字、Shift+Enter 换行、清空、Escape 隐藏建议、Tab 接受建议、插入资源后继续输入、跨引用复制、撤销均通过。复制文字与内部片段不含锚点或灰色建议。
- 合成 compositionstart/end 验证期间不重建正在编辑的锚点，结束后规范化为普通文字；未宣称覆盖所有真实系统输入法。
- 深色/原生圆角兼容模式、420px 窄窗口：光标 x=45，与编辑器左边界相同，无页面横向溢出。截图 `/tmp/lake-caret-fixed-empty.png`、`/tmp/lake-caret-dark-narrow.png`。

## Lake Dev

保留尚未合入 develop 的 K8s 能力，使用本地 `codex/dev-composer-caret` 集成分支（原 PR #126 + 本修复）构建；没有合并任一 GitHub PR，也没有把 K8s 改动放进本修复 PR。

- 安装来源 `5bea9187c9dcfabeceeb79eb891c457d67432112`（干净提交）；其 Web 源码与独立修复分支完全一致。
- 经 `scripts/build_lake_desktop.sh --dev --install` 签名安装并重启 `~/Applications/Lake Dev.app`，Home 仍为 `~/.lake-dev`。深度签名、后端 SHA256、实际后台返回的 CSS 与本次构建一致；新后台 PID 92794。
- 原生 WebKit 窗口的空草稿灰色历史建议出现后，光标实际绘制在文字左侧，发送仍禁用；未发送测试消息或修改真实资源。
- 证据 `/tmp/lake-caret-dev-proof.json`；构建及测试日志 `/tmp/lake-caret-*.log`。本次只改 React/CSS 和文档，没有重跑 Go/race 后端套件或 Windows 桌面。

风险与回退：编辑器辅助 DOM 的选区恢复改变，但草稿格式、引用身份和后端协议不变。通过 develop 回退 PR 可撤销本次 4 个实现/测试/规范文件的修改，无数据迁移；本地集成分支保留用于匹配已安装 Dev 的源码来源。
