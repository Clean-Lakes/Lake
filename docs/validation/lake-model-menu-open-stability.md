# 模型菜单打开时的闪动

2026-10-22。修复打开菜单后刷新目录时，缓存选项被 available.loading 清空、随后重建导致的卡片缩放。ComposerModelSelect 保留已有选项；后台刷新失败时 App 保留缓存并提示错误，不将列表清空。原生面板仅在实际变化时更新 appearance 和 frame/shadow，避免同一状态重复重绘玻璃表面。

验证：TypeScript 检查与 9 项模型状态/思考强度标签/保存队列测试通过。原生内容 fixture 在刷新 loading=true 时两个模型行保持原节点、卡片高度差为 0、未显示读取中占位；结束刷新后无新增 resize 事件。完整 App fixture 延迟刷新：重复打开期间与刷新后均保持两个选项和 205px 高度，底部 deepseek-flash/高 标签不变；模拟刷新失败保留两个选项、菜单仍展开并显示错误，Escape 关闭且焦点回到触发器。

Swift 包采用可执行断言目标，swift test --filter ModelPanel 虽完成编译但没有 testTarget，报告 no tests found；改用仓库的 swift run --package-path client/macos LakeWindowTests 验证。后续通过签名脚本更新本地 Dev 并检查原生界面，不操作正式应用。
