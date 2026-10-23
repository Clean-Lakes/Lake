# 适时提问与成功更新清理验证

日期：2026-10-14。

## 提问

模型提示词要求先使用当前请求、历史选择和可查证的工具证据，只在答案会实质改变下一步的目标、范围、约束或交付时使用结构化问题。明确指令、常规默认值、已回答或未变化的已跳过问题不会被要求反复确认。实际触发仍由所选模型依据上下文判断。

工具接受旧字符串选项及 label/description/recommended 对象，不预选答案。卡片逐题显示 1/N，支持多选与补充同时提交、上一题/下一题、跳过、收起、关闭剩余问题和 Cmd/Ctrl+Enter。相同轮次、内容完全相同的请求复用已记录回答；跳过会明确告知模型继续独立工作，不能猜测必要目标或绕过权限。

真实浏览器用隔离后端和本地合成模型验证了：

1. 初始所有选项为空，展示选项说明和推荐标记。
2. 同时选择“整体架构与 API”“核心业务与日志”，填写“补充检查磁盘容量”。
3. Cmd+Enter 进入 2/2；返回 1/2 后两项选择及补充文本保持。
4. 再进入 2/2 并跳过；问题卡消失，模型继续，任务进度完成。

截图：[逐题选择卡](lake-context-question-card.png)。

## 更新清理

macOS 新版工作台发出匹配版本的 ready 回执后，安装器才创建 complete 标记、删除本次备份与工作目录。启动清理只处理 Lake 命名且 bundle ID、版本匹配的旧备份，以及完成的 UUID 下载目录。旧版仅有 ready 的任务需超过回退窗口且进程已退出。失败继续恢复原应用。手动 --install 先验证暂存应用，安装失败恢复，安装成功后清理本次备份。

Windows NSIS 成功后保存完成标记并立即删除大安装包；新客户端重试清理仍被锁定的助手，保留完成标记至最后。清理仅处理已完成的 job-* 目录及已知文件，拒绝符号链接、未来版本、未知文件和失败任务。用户数据、Downloads 及发布归档不属于清理范围。

## 验证结果

- `go test -race ./internal/ai ./internal/web ./internal/desktopupdate -timeout=150s`：全部通过（ai 25.766s、web 96.875s、desktopupdate 1.428s）。
- 前端 TypeScript 检查：通过。前端测试：106 项通过。
- `swift run --package-path client/macos --build-system native LakeUpdateTests`：通过，含备份身份/版本/链接边界、完成任务清理和旧 ready 活跃进程保护。
- `python3 scripts/test_lake_macos_installer.py`：5 个隔离场景通过：成功清理、启动失败回退、无回执回退、错误版本回执回退、替换失败回退。
- `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c ./client/windows`：交叉编译通过；未在 Windows 真机执行安装或验证文件锁定重试。
- `scripts/build_lake_desktop.sh`：签名 Go 二进制及 macOS App/ZIP/DMG 构建成功；`codesign --verify --strict bin/lake` 和 `codesign --verify --deep --strict dist/macos/0.3.6/arm64/Lake.app` 通过。
- 真实浏览器 fixture：通过；未调用真实外部模型、修改用户数据或安装到当前 Applications。
- `git diff --check`：通过。已有工作区改动被保留。
