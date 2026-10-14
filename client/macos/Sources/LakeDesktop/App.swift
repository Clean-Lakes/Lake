import AppKit
import WebKit
import LakeUpdateCore

@MainActor private final class WorkbenchWindow: NSWindow {
    var shouldStartDrag: (NSEvent) -> Bool = { _ in false }
    private var dragStart: (mouse: NSPoint, origin: NSPoint)?
    private var zoomingHeaderClick = false
    override func sendEvent(_ event: NSEvent) {
        // Consume header drags before WKContentView turns them into web selection gestures.
        if event.type == .leftMouseDown { dragStart = nil; zoomingHeaderClick = false }
        if event.type == .leftMouseDown, isMovable, !styleMask.contains(.fullScreen), shouldStartDrag(event) {
            makeKeyAndOrderFront(nil)
            if event.clickCount == 2 {
                zoomingHeaderClick = true
                performZoom(nil)
                return
            }
            dragStart = (convertPoint(toScreen: event.locationInWindow), frame.origin)
            return
        }
        if zoomingHeaderClick {
            if event.type == .leftMouseUp { zoomingHeaderClick = false; return }
            if event.type == .leftMouseDragged { return }
        }
        if let start = dragStart {
            if event.type == .leftMouseDragged {
                let mouse = convertPoint(toScreen: event.locationInWindow)
                setFrameOrigin(NSPoint(x: start.origin.x + mouse.x - start.mouse.x,
                                       y: start.origin.y + mouse.y - start.mouse.y))
                return
            }
            if event.type == .leftMouseUp { dragStart = nil; return }
        }
        super.sendEvent(event)
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let backend = Backend()
    private let updater = Updater()
    private let profile = DesktopProfile(bundleIdentifier: Bundle.main.bundleIdentifier)
    private var origin: URL?
    private var terminating = false
    private var ready = false
    private var dragRegions: [NSRect] = []
    private var dragExcluded: [NSRect] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        // LaunchServices can open the app more than once. Keep one owner of the backend and updater.
        if let existing = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "com.cleanlakes.lake.desktop")
            .first(where: { $0.processIdentifier != getpid() }) {
            existing.activate(options: [.activateIgnoringOtherApps])
            NSApp.terminate(nil)
            return
        }
        refreshApplicationIcon()
        if profile.isDevelopment { NSApp.dockTile.badgeLabel = "DEV" }
        installMenu()
        let config = WKWebViewConfiguration()
        if let appearance = UserDefaults.standard.string(forKey: "LakeAppearance"),
           ["light", "dark", "system"].contains(appearance) {
            config.userContentController.addUserScript(WKUserScript(source: "window.lakeAppearance = '\(appearance)';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        if let widths = UserDefaults.standard.dictionary(forKey: "LakeWorkbenchWidths"),
           JSONSerialization.isValidJSONObject(widths), let data = try? JSONSerialization.data(withJSONObject: widths),
           let json = String(data: data, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: "window.lakeWorkbenchWidths = \(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // Native chrome applies even when attaching to an independently running older Go service.
        let headerControlsInset = 16
        let chrome = """
        document.documentElement.classList.add('lake-native');
        const style = document.createElement('style');
        style.textContent = `
          html.lake-native { --lake-titlebar-height: 52px; }
          .lake-native .sidebar { padding-top: var(--lake-titlebar-height); }
          .lake-native .workspace-header { min-height: var(--lake-titlebar-height); padding-right: \(headerControlsInset)px; }
          /* Web update and terminal controls share the same header inset. */
          .lake-native .terminal-panel-header { min-height: var(--lake-titlebar-height); padding-right: \(headerControlsInset)px; }
          .lake-native .session-edit, .lake-native .session-more { background: transparent; }
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
        if profile.isDevelopment {
            let developmentBadge = """
            document.documentElement.classList.add('lake-development');
            const badgeStyle = document.createElement('style');
            badgeStyle.textContent = '.lake-development .brand::after { content: "DEV"; font: 600 10px system-ui; padding: 3px 5px; border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary); }';
            document.head.appendChild(badgeStyle);
            document.title = 'Lake Dev';
            """
            config.userContentController.addUserScript(WKUserScript(source: developmentBadge, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        config.userContentController.add(self, name: "lakeChrome")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "lakeUpdates")
        let updateBridge = "window.lakeDesktopUpdates = {platform:'macOS', development:\(profile.isDevelopment ? "true" : "false"), command: action => window.webkit.messageHandlers.lakeUpdates.postMessage({action})};"
        config.userContentController.addUserScript(WKUserScript(source: updateBridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let layoutURL = Bundle.main.url(forResource: "workbench-layout", withExtension: "js"),
           let layout = try? String(contentsOf: layoutURL, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: layout, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window = WorkbenchWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = profile.name
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unified
        window.backgroundColor = NSColor.white
        window.minSize = NSSize(width: 850, height: 600)
        window.contentView = webView
        (window as? WorkbenchWindow)?.shouldStartDrag = { [weak self] event in
            guard let self, self.sameOrigin(self.webView.url) else { return false }
            let local = self.webView.convert(event.locationInWindow, from: nil)
            let point = NSPoint(x: local.x, y: self.webView.isFlipped ? local.y : self.webView.bounds.height - local.y)
            let height = max(40, self.window.frame.height - self.window.contentLayoutRect.height)
            return point.y >= 0 && point.y < height && point.x >= 96 && point.x <= self.webView.bounds.width - 72
                && self.dragRegions.contains(where: { $0.contains(point) })
                && !self.dragExcluded.contains(where: { $0.insetBy(dx: -2, dy: -2).contains(point) })
        }
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("LakeWorkbench")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        updater.changed = { [weak self] state in self?.renderUpdate(state) }
        renderUpdate(updater.state)
        updater.start()
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(updateAccessibilityChanged), name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
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
    private func refreshApplicationIcon() {
        // The updater replaces the bundle at the same path before relaunching. Load the
        // icon from this process's bundle so the Dock does not keep the previous one.
        guard let url = Bundle.main.url(forResource: "Lake", withExtension: "icns"),
              let icon = NSImage(contentsOf: url) else { return }
        NSApp.applicationIconImage = icon
        NSApp.dockTile.display()
    }
    private func installMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 " + profile.name, action: #selector(about), keyEquivalent: "")
        if profile.allowsReleaseUpdates {
            appMenu.addItem(withTitle: "检测更新…", action: #selector(checkUpdates), keyEquivalent: "")
        }
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 " + profile.name, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: profile.name, .applicationVersion: updater.state.currentVersion])
    }
    @objc private func checkUpdates() {
        guard sameOrigin(webView?.url) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('lake-open-updates'));", completionHandler: nil)
    }
    private func renderUpdate(_ state: UpdateState) {
        guard sameOrigin(webView?.url), let data = try? JSONEncoder().encode(state),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('lake-desktop-update', {detail: \(json)}));", completionHandler: nil)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.name == "lakeUpdates", message.frameInfo.isMainFrame,
              sameOrigin(message.frameInfo.request.url), let body = message.body as? [String: Any],
              let action = body["action"] as? String, ["state", "check", "install"].contains(action) else {
            replyHandler(nil, "更新请求不可用")
            return
        }
        Task {
            if action == "check" { await updater.check(preview: profile.isDevelopment) }
            if action == "install" { await updater.install() }
            guard let data = try? JSONEncoder().encode(updater.state),
                  let value = try? JSONSerialization.jsonObject(with: data) else {
                replyHandler(nil, "更新状态无法读取")
                return
            }
            replyHandler(value, nil)
        }
    }
    @objc private func updateAccessibilityChanged() { renderUpdate(updater.state) }
    func applicationDidBecomeActive(_ notification: Notification) {
        guard ready else { return }
        renderUpdate(updater.state)
        Task { await updater.checkIfDue() }
    }
    func windowDidResize(_ notification: Notification) { syncChromeHeight() }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "lakeChrome", message.frameInfo.isMainFrame,
              sameOrigin(message.frameInfo.request.url), let body = message.body as? [String: Any] else { return }
        if let theme = body["theme"] as? String, theme == "light" || theme == "dark" {
            let dark = theme == "dark"
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.backgroundColor = dark ? NSColor(calibratedWhite: 23/255, alpha: 1) : .white
        }
        if let appearance = body["appearance"] as? String,
           ["light", "dark", "system"].contains(appearance) {
            UserDefaults.standard.set(appearance, forKey: "LakeAppearance")
        }
        if body["widths"] != nil {
            if let widths = body["widths"] as? [String: Double], let sidebar = widths["sidebar"], let terminal = widths["terminal"],
               sidebar.isFinite, terminal.isFinite, (200...420).contains(sidebar), (280...900).contains(terminal) {
                UserDefaults.standard.set(["sidebar": sidebar, "terminal": terminal], forKey: "LakeWorkbenchWidths")
            }
            return
        }
        func rectangles(_ key: String) -> [NSRect] {
            guard let values = body[key] as? [[Double]], values.count <= 100 else { return [] }
            return values.compactMap { value in
                guard value.count == 4, value.allSatisfy({ $0.isFinite }), value[2] > 0, value[3] > 0 else { return nil }
                return NSRect(x: value[0], y: value[1], width: value[2], height: value[3])
            }
        }
        dragRegions = rectangles("regions")
        dragExcluded = rectangles("excluded")
    }
    private func syncChromeHeight() {
        guard sameOrigin(webView?.url) else { return }
        let height = max(40, window.frame.height - window.contentLayoutRect.height)
        webView.evaluateJavaScript("document.documentElement.style.setProperty('--lake-titlebar-height', '\(height)px'); window.dispatchEvent(new Event('lake-chrome-resize'));", completionHandler: nil)
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
        if !ready { ready = true }
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
