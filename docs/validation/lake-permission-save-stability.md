# 执行偏好保存时的说明跳动

2026-10-22。原因：AIControls 将保存 busy 和会话 running 都作为 PermissionSettings.disabled，导致保存期间插入“本轮结束或停止后可调整”，面板高度和锚点定位随之变化；真实 disabled 也可能让当前按钮失去焦点。

修复：分离 saving 与 disabled。保存期间设置面板 aria-busy、按钮 aria-disabled，并保护点击处理，保留按钮焦点和原有显示值；仅在真实运行/等待审批时使用 disabled 并显示锁定提示。保存成功后继续使用服务端返回值，失败不展示未经确认的新状态。CSS 不在保存期间切换 hover 样式。未重建说明节点或改动其 open 状态。

隔离 fixture 增加 800ms 保存延迟及失败模拟，无后端连接。浏览器验证：保存中 busy=true、原值仍为 false、真实 disabled=false、焦点保持、锁定提示不存在；追加 Enter 后保存请求计数仍为 1。保存前后面板 top/height 与说明 top 差值均为 0，面板和说明节点身份不变。已展开说明在下一次保存后保持展开。失败保留 false、busy 结束并显示错误；运行中七项仍真实禁用且显示锁定提示。TypeScript 检查通过，后续使用签名脚本构建并更新本地 Dev。
