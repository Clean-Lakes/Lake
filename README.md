<div align="center">

# Lake

**面向 SRE 的 AI 运维工作台**

连接资源，协同排障，让执行有迹可循。

[下载客户端](https://github.com/Clean-Lakes/Lake/releases) · [快速开始](#快速开始) · [SRE 协作](docs/sre-collaboration.md)

</div>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/lake-workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/lake-workbench-light.jpg">
  <img alt="Lake macOS 界面预览：资源导航、专员协作与对话工作区" src="docs/images/lake-workbench-light.jpg" width="1440">
</picture>

<p align="center"><sub>macOS 界面预览 · 当前版本 · 演示数据</sub></p>

## 为运维工作而设计

- **资源就在上下文里。** 按项目组织主机、数据库、Redis 和 Docker，将资源、会话和终端放在一起。
- **过程可以追溯。** 从工具调用到操作确认，再到执行记录与证据，随时查看，也能人工接管。
- **专员共同推进。** 开启实验性 SRE 协作，由协调者、调查员、执行员和验证员按需分工；用 Plan 跟进任务，用独立验证核对结果。

## 快速开始

1. [下载客户端](https://github.com/Clean-Lakes/Lake/releases)。支持 macOS Apple Silicon 与 Windows x86_64。
2. 在设置中连接模型，或通过 [Magpie Agent](https://github.com/Clean-Lakes/magpie-agent-lake) 接入。
3. 添加资源，描述要排查的问题。输入 `@` 可引用资源、Skills 和 MCP；开启 SRE 协作后也可引用专员。

普通模式由 Lake 直接处理。需要多人分工时，在输入框旁开启 **SRE 协作 · 实验性**；操作沿用会话权限。[了解使用与边界 →](docs/sre-collaboration.md)

<details>
<summary>本地开发</summary>

需要 Go 1.25、Node.js 24 和 pnpm。macOS 首次构建先运行 `scripts/setup_lake_signing.sh`，然后启动独立的 Lake Dev：

我们把自然界的几条常识，搬进了做软件的方式里。落到每一件事上，是六条共同原则——它们既是工程的，也是环保的：

Dev 使用 `~/.lake-dev`，与正式版数据分离。构建后的程序内嵌前端，运行时无需 Node.js。CLI 和独立 Web 开发见 [开发规范](CONTRIBUTING.md)。

</details>

---

[使用与开发](web-agent/README.md) · [macOS](client/macos/README.md) · [Windows](client/windows/README.md) · [贡献指南](CONTRIBUTING.md) · [Apache-2.0](LICENSE-APACHE)
