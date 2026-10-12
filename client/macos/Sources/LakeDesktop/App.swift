import AppKit
import WebKit
import LakeUpdateCore

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, NSToolbarDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let backend = Backend()
    private let updater = Updater()
    private var origin: URL?
    private var terminating = false
    private var ready = false
    private let updateButton = NSButton()
    private let updatePopover = NSPopover()
    private let updateMessage = NSTextField(wrappingLabelWithString: "正在检测更新…")
    private let updateVersion = NSTextField(labelWithString: "")
    private let updateAction = NSButton(title: "检测更新", target: nil, action: nil)
    private let updateProgress = NSProgressIndicator()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // LaunchServices can open the app more than once. Keep one owner of the backend and updater.
        if let existing = NSRunningApplication.runningApplications(withBundleIdentifier: "com.cleanlakes.lake.desktop")
            .first(where: { $0.processIdentifier != getpid() }) {
            existing.activate(options: [.activateIgnoringOtherApps])
            NSApp.terminate(nil)
            return
        }
        installMenu()
        let config = WKWebViewConfiguration()
        // Native chrome applies even when attaching to an independently running older Go service.
        let chrome = """
        document.documentElement.classList.add('lake-native');
        const style = document.createElement('style');
        style.textContent = `
          html.lake-native { --lake-titlebar-height: 52px; }
          .lake-native .sidebar { padding-top: var(--lake-titlebar-height); }
          .lake-native .workspace-header { min-height: var(--lake-titlebar-height); padding-right: 72px; border-bottom: 0; }
          .lake-native .desktop-update { display: none; }
        `;
        document.head.appendChild(style);
        // 已有独立 Go 服务可能仍提供旧页面；同样保留菜单焦点直到 click 完成。
        document.addEventListener('mousedown', event => {
          if (event.button === 0 && event.target instanceof Element && event.target.closest('.resource-add-menu [role="menuitem"]')) {
            event.preventDefault();
          }
        }, true);
        """
        config.userContentController.addUserScript(WKUserScript(source: chrome, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Lake"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unified
        window.backgroundColor = NSColor(calibratedRed: 252/255, green: 251/255, blue: 248/255, alpha: 1)
        window.minSize = NSSize(width: 850, height: 600)
        window.contentView = webView
        installUpdateToolbar()
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("LakeWorkbench")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        updater.changed = { [weak self] state in self?.renderUpdate(state) }
        renderUpdate(updater.state)
        updater.beforeInstall = { [weak self] in
            guard let self else { throw UpdateError.message("应用正在退出。") }
            let context = InstallContext(pid: self.backend.process?.processIdentifier ?? 0, home: self.backend.home, data: self.backend.dataDirectory)
            await self.backend.stop()
            guard self.backend.process?.isRunning != true else { throw UpdateError.message("后端尚未退出，更新未安装，请稍后重试。") }
            return context
        }
        writeReceiptPID()
        Task {
            do {
                let url = try await backend.start()
                origin = backend.runtime?.url
                if let receipt = receiptURL(), let child = backend.process {
                    try? String(child.processIdentifier).data(using: .utf8)?.write(to: URL(fileURLWithPath: receipt.path + ".backend"), options: .atomic)
                }
                webView.load(URLRequest(url: url))
            } catch {
                let alert = NSAlert()
                alert.messageText = "Lake 无法启动"
                alert.informativeText = error.localizedDescription
                alert.runModal()
                NSApp.terminate(nil)
            }
        }
    }
    private func installMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Lake", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(withTitle: "检测更新…", action: #selector(checkUpdates), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Lake", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let edit = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", Selector(("undo:")), "z"), ("剪切", #selector(NSText.cut(_:)), "x"),
                                     ("复制", #selector(NSText.copy(_:)), "c"), ("粘贴", #selector(NSText.paste(_:)), "v"),
                                     ("全选", #selector(NSText.selectAll(_:)), "a")] {
            editMenu.addItem(withTitle: title, action: action, keyEquivalent: key)
        }
        edit.submenu = editMenu
        menu.addItem(edit)
        NSApp.mainMenu = menu
    }
    @objc private func about() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "Lake", .applicationVersion: updater.state.currentVersion])
    }
    @objc private func checkUpdates() {
        showUpdates()
        Task { await updater.check() }
    }
    private func installUpdateToolbar() {
        updateButton.image = NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: "检测更新")
        updateButton.imagePosition = .imageOnly
        updateButton.bezelStyle = .texturedRounded
        updateButton.isBordered = false
        updateButton.target = self
        updateButton.action = #selector(toggleUpdates)
        updateButton.setAccessibilityLabel("检测更新")
        let toolbar = NSToolbar(identifier: "LakeUnifiedHeader")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.showsBaselineSeparator = false
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
        let controller = NSViewController()
        controller.view = NSView(frame: NSRect(x: 0, y: 0, width: 330, height: 216))
        let title = NSTextField(labelWithString: "Lake 客户端更新")
        title.font = .boldSystemFont(ofSize: 14)
        updateVersion.font = .systemFont(ofSize: 11)
        updateVersion.textColor = .secondaryLabelColor
        updateMessage.font = .systemFont(ofSize: 13)
        updateMessage.maximumNumberOfLines = 4
        updateProgress.style = .spinning
        updateProgress.controlSize = .small
        updateAction.bezelStyle = .rounded
        updateAction.target = self
        updateAction.action = #selector(performUpdateAction)
        let note = NSTextField(wrappingLabelWithString: "安装更新会关闭终端连接，完成后自动重新打开。")
        note.font = .systemFont(ofSize: 11)
        note.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [title, updateVersion, updateMessage, updateProgress, note, updateAction])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        controller.view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: controller.view.trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: controller.view.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: controller.view.bottomAnchor, constant: -18)
        ])
        updatePopover.contentViewController = controller
        updatePopover.behavior = .transient
    }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, .init("LakeUpdate")] }
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, .init("LakeUpdate")] }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard identifier.rawValue == "LakeUpdate" else { return nil }
        let item = NSToolbarItem(itemIdentifier: identifier)
        item.label = "检测更新"
        item.view = updateButton
        return item
    }
    @objc private func toggleUpdates() {
        if updatePopover.isShown { updatePopover.close() }
        else {
            showUpdates()
            if !["available", "checking", "downloading", "verifying", "installing"].contains(updater.state.status) {
                Task { await updater.check() }
            }
        }
    }
    private func showUpdates() {
        updatePopover.show(relativeTo: updateButton.bounds, of: updateButton, preferredEdge: .minY)
    }
    @objc private func performUpdateAction() {
        if updater.state.status == "available" { Task { await updater.install() } }
        else { Task { await updater.check() } }
    }
    private func renderUpdate(_ state: UpdateState) {
        updateVersion.stringValue = "当前版本 \(state.currentVersion) · master · Apple Silicon"
        updateMessage.stringValue = state.message
        updateButton.toolTip = state.message
        updateButton.contentTintColor = state.status == "available" ? .systemGreen : .secondaryLabelColor
        let busy = ["checking", "downloading", "verifying", "installing"].contains(state.status)
        updateAction.isEnabled = !busy
        updateAction.title = state.status == "available" ? "下载并重启更新 \(state.version ?? "")" : busy ? "正在处理…" : "重新检测"
        updateProgress.isHidden = !busy
        if busy { updateProgress.startAnimation(nil) } else { updateProgress.stopAnimation(nil) }
    }
    func windowDidResize(_ notification: Notification) { syncChromeHeight() }
    private func syncChromeHeight() {
        guard sameOrigin(webView?.url) else { return }
        let height = max(40, window.frame.height - window.contentLayoutRect.height)
        webView.evaluateJavaScript("document.documentElement.style.setProperty('--lake-titlebar-height', '\(height)px');", completionHandler: nil)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard backend.process?.isRunning == true else { return .terminateNow }
        if terminating { return .terminateCancel }
        terminating = true
        // AppKit's terminateLater uses a modal run loop which can starve Swift actor tasks.
        // Cancel this request, finish shutdown on the normal run loop, then terminate synchronously.
        Task {
            await backend.stop()
            terminating = false
            if backend.process?.isRunning != true { sender.terminate(nil) }
            else {
                let alert = NSAlert()
                alert.messageText = "Lake 后端正在退出"
                alert.informativeText = "后台操作尚未结束，请稍后再退出。"
                alert.beginSheetModal(for: window, completionHandler: nil)
            }
        }
        return .terminateCancel
    }
    private func sameOrigin(_ url: URL?) -> Bool {
        guard let url, let origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if sameOrigin(url) || url?.scheme == "blob" {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated, let url, ["https", "http"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme ?? ""), !sameOrigin(url) {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard sameOrigin(frame.request.url) else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard sameOrigin(webView.url) else { return }
        syncChromeHeight()
        if !ready { ready = true; updater.start() }
        if let receipt = receiptURL() {
            try? updater.state.currentVersion.data(using: .utf8)?.write(to: receipt, options: .atomic)
        }
    }
    private func receiptURL() -> URL? {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: "--lake-update-receipt"), index + 1 < args.count else { return nil }
        let file = URL(fileURLWithPath: args[index + 1]).standardizedFileURL
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Lake/updates", isDirectory: true).standardizedFileURL
        guard file.lastPathComponent == "ready", file.deletingLastPathComponent().deletingLastPathComponent() == directory else { return nil }
        return file
    }
    private func writeReceiptPID() {
        if let receipt = receiptURL() {
            try? String(getpid()).data(using: .utf8)?.write(to: URL(fileURLWithPath: receipt.path + ".pid"), options: .atomic)
        }
    }
}

@main struct LakeLauncher {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}
