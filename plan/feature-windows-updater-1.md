---
goal: Windows 客户端检查、下载并安装 GitHub master 正式更新
version: 1
date_created: 2026-10-12
last_updated: 2026-10-12
owner: Lake
status: 'Completed'
tags: [feature, windows, updater]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

为当前 Windows Go/WebView2 客户端添加可见更新入口与经校验的安装流程。

## 1. Requirements & Constraints

- **REQ-001**: 左下角提供检查更新按钮、版本与下载进度；浏览器不显示桌面更新入口。
- **REQ-002**: 仅接受 Clean-Lakes/Lake、master、非草稿非预发布、版本高于当前的 Windows x86_64 安装 EXE。
- **SEC-001**: 精确限制下载 URL、HTTPS 重定向、大小、SHA256 校验文件与 GitHub digest；更新目录使用当前用户私有 ACL。
- **SEC-002**: 原生桥验证随机能力令牌；令牌仅在当前后台 origin 的主 frame 中初始化。安装需要原生确认。
- **CON-001**: macOS bin/lake 仅通过 scripts/build_lake.sh 签名构建；不得启动持久测试服务或输出凭据。
- **CON-002**: Windows 执行环境不可用时明确记录编译与实机验证差异。

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: 建立可在 macOS 验证的发布策略与下载校验。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/desktopupdate/policy.go 实现严格版本、发布、URL 与摘要规则，client.go 实现限额 HTTP 下载；测试覆盖恶意发布与损坏安装包。 | ✅ | 2026-10-12 |

### Implementation Phase 2

- GOAL-002: 接入 Windows 桌面桥、安装助手、安装后重启和客户端入口；依赖 TASK-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-002 | client/windows/updater_windows.go 与 update_helper_windows.go 实现状态、后台下载、私有任务、等待父进程退出、启动安装器，installer.nsi 支持 LAKEUPDATE 后重启。 | ✅ | 2026-10-12 |
| TASK-003 | web-agent/web/src/DesktopUpdate.tsx 实现仅 Windows 桌面显示的按钮与更新对话框，App.tsx 接入。 | ✅ | 2026-10-12 |
| TASK-004 | 执行策略及下载测试、前端检查和测试、Windows vet 与交叉编译、NSIS 打包并验证 SHA256；记录实机限制。 | ✅ | 2026-10-12 |

## 3. Alternatives

- **ALT-001**: 仅打开浏览器下载页面不满足客户端下载安装要求。
- **ALT-002**: 引入 Electron/Sparkle 不适合现有 Go/WebView2 客户端。

## 4. Dependencies

- **DEP-001**: GitHub public Releases API、现有 .exe 与 .sha256 资产。
- **DEP-002**: NSIS 用户级安装器与 Go Windows 进程等待 API。

## 5. Files

- **FILE-001**: internal/desktopupdate/ 的发布策略、HTTP 实现与测试。
- **FILE-002**: client/windows/main_windows.go、updater_windows.go、update_helper_windows.go、installer.nsi、README.md。
- **FILE-003**: web-agent/web/src/DesktopUpdate.tsx、desktopUpdate.css、App.tsx。

## 6. Testing

- **TEST-001**: Semver、master 过滤、平台/文件名/URL 限制、摘要/大小不匹配拒绝、HTTP 失败和并发取消。
- **TEST-002**: Windows 桌面桥与安装助手交叉编译，前端类型检查和测试。
- **TEST-003**: 生成 EXE/ZIP 并校验 CRC、amd64 与 SHA256；Windows 实机自动更新另外记录。

## 7. Risks & Assumptions

- **RISK-001**: 目前应用无 Authenticode 签名；信任来源为 HTTPS GitHub 官方仓库与摘要匹配。
- **RISK-002**: 安装会关闭终端连接；原生确认与对话框明确告知。
- **ASSUMPTION-001**: 更新安装到用户级标准目录，保留 ~/.lake；免安装用户更新后使用安装版。

## 8. Related Specifications / Further Reading

- client/macos/Sources/LakeUpdateCore/Release.swift
- https://docs.github.com/en/rest/releases/releases
- https://nsis.sourceforge.io/Docs/Chapter4.html
