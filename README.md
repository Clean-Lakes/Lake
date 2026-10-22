<div align="center">

# Lake

**English** · [简体中文](README.zh-CN.md)

**An AI operations workspace for SREs**

Connect resources, troubleshoot together, and keep a clear record of every action.

[Download](https://github.com/Clean-Lakes/Lake/releases) · [Quick start](#quick-start) · [SRE collaboration](docs/sre-collaboration.md)

</div>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/lake-workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/lake-workbench-light.jpg">
  <img alt="Lake macOS workspace with resource navigation, specialist collaboration, and conversation history" src="docs/images/lake-workbench-light.jpg" width="1440">
</picture>

<p align="center"><sub>macOS interface preview · v0.3.21 · Fictional demo data · UI shown in Chinese</sub></p>

## Built for operations

- **Resources stay in context.** Organize hosts, databases, Redis, and Docker by project, with resources, conversations, and terminals in one workspace.
- **Every action has a record.** Review tool calls, approval requests, execution history, and evidence, and take over manually when needed.
- **Specialists work together.** Enable experimental SRE collaboration to coordinate investigators, executors, and verifiers. Track work with a plan and check results through independent verification.

## Plan mode

Choose **Plan** beside the composer or enter `/plan` to toggle planning; `/plan <goal>` starts a planning request. Lake investigates with read-only tools, asks about material choices, and presents a reviewable plan. Revise it in the conversation or choose **Execute plan** to continue under the existing session permissions. Mode and plans persist per conversation; stale or duplicate executions are rejected.

## Quick start

1. [Download the client](https://github.com/Clean-Lakes/Lake/releases) for macOS Apple Silicon or Windows x86_64.
2. Connect a model in settings, or connect through [Magpie Agent](https://github.com/Clean-Lakes/magpie-agent-lake).
3. Add resources and describe the problem. Type `@` to reference resources, Skills, and MCP integrations, or specialists when SRE collaboration is enabled.

Lake handles requests directly in standard mode. For tasks that benefit from specialist roles, enable **SRE collaboration · Experimental** beside the composer. Operations follow the conversation’s existing permissions. [Usage and limitations (Chinese) →](docs/sre-collaboration.md)

Strategy assets, candidate learning, and bounded read-only correction are experimental and off by default. See the [usage and exit guide (Chinese)](docs/strategy-learning.md) for scope, version adoption, budgets, and validation limits.

<details>
<summary>Local development</summary>

Create a working branch from `develop`, open a PR into `develop`, and validate changes in Lake Dev. Production changes reach `master` through a `develop → master` release PR. Before editing, read the [branch and release workflow](docs/development-workflow.md) and [contributing guide](CONTRIBUTING.md). AI agents must also follow the root `AGENTS.md`.

You need Go 1.26.6 (see `go.mod`), Node.js 24, and pnpm. Before your first macOS build, run `scripts/setup_lake_signing.sh`. Then build and launch the isolated Lake Dev app:

```sh
pnpm --dir web-agent install --frozen-lockfile
scripts/build_lake_desktop.sh --dev --install
open "$HOME/Applications/Lake Dev.app"
```

Dev uses `~/.lake-dev`, separate from production data. The built application embeds the frontend and does not require Node.js at runtime. See [Contributing](CONTRIBUTING.md) for CLI and standalone web development.

</details>

## Community and feedback

Using Lake? We welcome real-world use cases and suggestions.

<p>
  <img src="docs/images/wechat.svg" alt="WeChat" width="20" height="20" align="absmiddle">&nbsp; <strong>WeChat</strong>&nbsp; <code>13025452443</code>
</p>

---

[Usage and development](web-agent/README.md) · [macOS](client/macos/README.md) · [Windows](client/windows/README.md) · [Contributing](CONTRIBUTING.md) · [Apache-2.0](LICENSE-APACHE)
