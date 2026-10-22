# Lake 官网

按用户指定的 [RustFS 中文官网](https://rustfs.com.cn/) 版式制作，替换为 Lake 的品牌、功能说明、项目入口与真实产品信息。保留原参考页的布局、字体、配色、响应式断点、地球可视化和八个功能面板的图示结构。

## 本地预览

在本目录运行：

```sh
python3 -m http.server 5187 --bind 127.0.0.1 --directory dist
```

打开 `http://127.0.0.1:5187/`。这是独立静态官网，不需要 Lake 后端或任何模型与资源凭据。

## 文件

- `dist/index.html`：页面结构与 Lake 文案，样式类与参考页一致。
- `dist/style.css`：Lake 内容适配及导航、标签页的补充样式。
- `dist/app.js`：主题、导航、功能面板、地球拖动与滚动交互。
- `dist/assets/core-panels.json`：八个功能面板的 HTML 与示意图。
- `dist/assets/reference/`：参考页样式与字体，所有运行资产本地加载。
- `dist/assets/providers/`：复用 Lake 的供应商品牌 SVG。
- `dist/assets/glyph.svg`：从 Lake 共享 Glyph 图标导出的静态 sprite。
- `.openai/hosting.json`：对应的 Sites 项目标识与静态部署目录。

下载入口指向 Lake 官方 GitHub Releases；文档与反馈入口指向项目仓库。工作台图片沿用仓库中的演示图片，不包含真实资源信息。图示中的进度、采样和耗时为界面示意。

## 验证

已在浏览器检查桌面与手机布局、八个功能面板、桌面下拉导航、手机导航、主题切换与本地资产。JavaScript 使用 `node --check dist/app.js` 验证语法。

## 第三方资源

- COBE 0.6.5：MIT，许可证位于 `dist/assets/vendor/COBE-LICENSE.txt`。
- Phenomenon 1.6.0：MIT，许可证位于 `dist/assets/vendor/PHENOMENON-LICENSE.txt`。
- Geist 字体：SIL Open Font License，许可证位于 `dist/assets/reference/GEIST-LICENSE.txt`。
- 图标与模型标志沿用 Lake 现有资源；供应商标志用于识别相应服务。
