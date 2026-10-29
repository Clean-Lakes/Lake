# 资源目录模态编辑

2026-10-29，PR #120 界面增量。新建根目录、新建子目录、重命名此前将 form 放进资源树顶部，导致列表下移且输入时可能滚向顶部。现在使用挂载到 document.body 的原生 dialog.showModal，复用现有 presentation-dialog 外观、22px 弹窗/10px 控件曲线和 Glyph；表单独立于侧栏滚动及裁切。位置显示真实项目及父目录路径，接口仍为原 resource-tree API。

新建打开时不提前展开目录；保存成功后才展开实际目标目录。名称打开即聚焦，重命名选中原名称。Enter 提交，输入法组合回车不提交；空白名称禁用保存。Escape、取消及关闭按钮在空闲时关闭并恢复原目录/新建入口焦点。保存中禁用编辑、重复提交和关闭；失败保留原名称，错误仅在弹窗内展示。

已用 ego-browser 操作真实 App + ResourceTree 的隔离 fixture：

- 弹窗为 document.body 直接子节点且匹配 :modal；资源树内 form 数量为零。打开前后目标行 top=298、scrollTop=0 不变；已滚动场景 top=638、scrollTop=917 不变，取消后仍为917。
- 根目录创建提交 parentId=null；子目录创建提交 parentId=apps，并在同一父目录内出现；重命名保留 nodeId 和归属。全部只改虚构内存目录。
- 空白名称、IME 回车、保存中 Escape 及按钮禁用通过；挂起请求只提交一次，完成后关闭并回到入口。模拟503失败保留名称并显示错误，重试成功；取消不产生请求。
- 浅/深色、输入焦点、选中原名、保存/取消与 420×520 窄窗口通过。窄窗弹窗 left=17、right=403，按钮完整可见，无自身横向溢出；圆角与内容裁切已目视检查。截图 `/tmp/lake-folder-dialog-light.png`、`/tmp/lake-folder-dialog-dark.png`、`/tmp/lake-folder-dialog-dark-narrow.png`。

前端 539/539、TypeScript 与 Web 构建通过；既有大 chunk 提示保留。本增量无 Go/存储接口修改，未重复执行 Go 回归。官方签名 Lake Dev 安装的准确来源、签名及后端摘要在 PR #120 / build-origin.json 核对；保留当前运行进程，重开加载新版本。不触碰真实项目资源或截图中的发布/数据库环境。回退只恢复 ResourceTree 的表单挂载方式，不更改目录数据。
