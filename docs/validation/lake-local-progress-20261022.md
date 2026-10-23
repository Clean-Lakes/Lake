# 主目录未提交进度整理

本批从最新 develop 创建独立分支，原主目录 experiment/adk-runtime 的文件与暂存区未修改。

## 当前可执行内容

- 新增独立 dsh-plugin-ops-data：SQLite 运维数据、导入、只读查询工具与插件测试。插件尚需真实 DSH 工具注册表的 schema 验证。
- 新增已有静态官网及本地资源、许可证；不包含部署账号元数据，不执行发布。
- 保留主目录的混元 TokenHub 供应商预设及 hy3/hy4 品牌匹配修复。接口配置沿用原有工作区，未做真实 API 联调。
- 保存尚未入库的 Lake 历史验证材料。它们反映各自记录的旧提交，不能视为本 PR 的验收结果。

## 未整合源码与排除项

文件级清单见 lake-local-progress-inventory.json。lake-local-progress-unreconciled.patch 使用零上下文 diff 保存 35 个旧工作区文件相对 develop 的差异，仅供审阅；**不可直接应用**，其中包含已被近期修复替代的旧逻辑。当前运行源码保留 develop 的审批恢复、计划历史、Windows 启动及前端修复。

已在 develop 历史出现的文件版本不重复提交。外部逆向提取目录 docs/hexhub-ai/、重复生成目录 assets/web/dist 2/、临时 .zcode/ 与网站 .openai/ 部署元数据保持在原目录，未打入产品 PR。原始 .txt 第三方许可证随网站一并保存。

## 本次验证

- Node 24.19.0；TypeScript 检查通过。
- 前端回归 418 项通过。
- Vite 前端构建通过。
- 运维数据插件 29 项测试通过。
- 官网 JavaScript 语法检查通过，本地引用缺失 0 项。
- 插件 verify-schemas 未完成：需要真实 @deepseek-ai/dsh-tools 入口，本次环境没有显式配置。
- 未运行真实 provider 请求、DSH 宿主联调、Windows 原生客户端或本批 Lake Dev 安装验收。

本 PR 为进度保存草稿，待旧源码核对、插件宿主集成与历史材料审阅后再判断可合并性。本次不合并、不发布、不覆盖客户端。
