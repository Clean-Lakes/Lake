import AppKit
import WebKit
import LakeDesktopCore

@MainActor protocol ModelPanelHosting: AnyObject {
    func show(_ state: [String: Any]) -> Bool
    func close(notify: Bool, restoreFocus: Bool)
}

@MainActor extension ModelPanelHosting {
    func close(notify: Bool) { close(notify: notify, restoreFocus: false) }
}

// Older SDKs keep the web fallback; Liquid Glass requires the macOS 26 SDK.
#if compiler(>=6.2)
@MainActor private final class ModelPanelWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

private final class TransparentPanelWebView: WKWebView {
    override var isOpaque: Bool { false }
}

/// AppKit owns the material. The transparent content reuses Lake's AppSelect and reasoning controls.
@available(macOS 26.0, *)
@MainActor final class NativeModelPanel: NSObject, ModelPanelHosting, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    static func bridge(role: String) -> WKUserScript {
        WKUserScript(source: "window.lakeNativeModelPanel={role:'\(role)',command:message=>window.webkit.messageHandlers.lakeModelPanel.postMessage(message)};",
                     injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    private weak var parent: NSWindow?
    private weak var mainWebView: WKWebView?
    private let origin: URL
    private let panel: NSPanel
    private let content: WKWebView
    private var state: [String: Any]?
    private var ready = false
    private var measured = false
    private var wantsOpen = false
    private var height: CGFloat = 220
    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var deactivateObserver: NSObjectProtocol?

    init(parent: NSWindow, webView: WKWebView, origin: URL) {
        self.parent = parent
        self.mainWebView = webView
        self.origin = origin
        panel = ModelPanelWindow(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = webView.configuration.websiteDataStore
        configuration.userContentController.addUserScript(Self.bridge(role: "panel"))
        content = TransparentPanelWebView(frame: .zero, configuration: configuration)
        super.init()
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "lakeModelPanel")
        content.navigationDelegate = self
        content.underPageBackgroundColor = .clear
        content.focusRingType = .none
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.clear.cgColor
        content.layer?.cornerRadius = 18
        content.layer?.masksToBounds = true
        content.setAccessibilityLabel("模型与思考强度")
        let glass = NSGlassEffectView()
        glass.style = .regular
        glass.cornerRadius = 18
        glass.contentView = content
        panel.contentView = glass
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.title = "模型与思考强度"
        panel.setAccessibilityLabel("模型与思考强度")
        // Same authenticated origin and cookie store; no credentials enter the script bridge or URL.
        var page = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        page.path = "/"
        page.query = "lake-native-model-panel=1"
        content.load(URLRequest(url: page.url!))
    }

    func show(_ state: [String: Any]) -> Bool {
        guard let id = state["id"] as? String, !id.isEmpty, id.count <= 128,
              let anchor = state["anchor"] as? [String: Double],
              let left = anchor["left"], let top = anchor["top"], let width = anchor["width"], let height = anchor["height"],
              [left, top, width, height].allSatisfy({ $0.isFinite }),
              let mainWebView, width > 0, height > 0, left >= 0, top >= 0,
              left + width <= mainWebView.bounds.width + 1, top + height <= mainWebView.bounds.height + 1,
              JSONSerialization.isValidJSONObject(state), let data = try? JSONSerialization.data(withJSONObject: state), data.count <= 524288 else { return false }
        self.state = state
        wantsOpen = true
        panel.appearance = NSAppearance(named: state["theme"] as? String == "dark" ? .darkAqua : .aqua)
        sendState()
        place()
        if ready && measured { present() }
        return true
    }

    private func place() {
        guard let parent, let mainWebView, let screen = parent.screen,
              let anchor = state?["anchor"] as? [String: Double],
              let x = anchor["left"], let y = anchor["top"], let width = anchor["width"], let anchorHeight = anchor["height"] else { return }
        let rect = NSRect(x: x, y: mainWebView.isFlipped ? y : mainWebView.bounds.height - y - anchorHeight, width: width, height: anchorHeight)
        let onScreen = parent.convertToScreen(mainWebView.convert(rect, to: nil))
        panel.setFrame(ModelPanelGeometry.frame(anchor: onScreen, visible: screen.visibleFrame, height: height), display: true)
    }

    private func present() {
        guard wantsOpen, let parent, parent.isVisible, !parent.isMiniaturized else { return }
        if !panel.isVisible {
            parent.addChildWindow(panel, ordered: .above)
            panel.makeKeyAndOrderFront(nil)
            panel.makeFirstResponder(content)
            localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) { [weak self] event in
                guard let self else { return event }
                if event.type == .keyDown && event.keyCode == 53 { self.close(notify: true, restoreFocus: true); return nil }
                if event.type != .keyDown && event.window !== self.panel { self.close(notify: true) }
                return event
            }
            globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in self?.close(notify: true) }
            deactivateObserver = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.close(notify: true) }
            }
        }
    }

    func close(notify: Bool, restoreFocus: Bool = false) {
        let wasOpen = wantsOpen
        wantsOpen = false
        parent?.removeChildWindow(panel)
        panel.orderOut(nil)
        if let localMonitor { NSEvent.removeMonitor(localMonitor); self.localMonitor = nil }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor); self.globalMonitor = nil }
        if let deactivateObserver { NotificationCenter.default.removeObserver(deactivateObserver); self.deactivateObserver = nil }
        // Retain the content so a pending reasoning save can finish and release the main UI's busy state.
        if notify && wasOpen, let id = state?["id"] as? String { relay(["id": id, "kind": "close", "restoreFocus": restoreFocus]) }
    }

    private func sendState() {
        guard ready, let state else { return }
        dispatch("lake-native-model-state", detail: state, into: content)
    }

    private func relay(_ event: [String: Any]) {
        guard let mainWebView, ModelPanelGeometry.sameOrigin(mainWebView.url, origin) else { return }
        dispatch("lake-native-model-event", detail: event, into: mainWebView)
    }

    private func dispatch(_ name: String, detail: [String: Any], into webView: WKWebView) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail, options: [.fragmentsAllowed]), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(name)',{detail:\(json)}));", completionHandler: nil)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.webView === content, message.frameInfo.isMainFrame, ModelPanelGeometry.sameOrigin(message.frameInfo.request.url, origin),
              let body = message.body as? [String: Any], let action = body["action"] as? String else { replyHandler(nil, "无效的模型面板请求"); return }
        switch action {
        case "ready": ready = true; sendState()
        case "resize":
            guard let value = body["height"] as? Double, value.isFinite, (1...420).contains(value) else { replyHandler(nil, "无效的面板高度"); return }
            height = value; measured = true; place(); present()
        case "event":
            guard let event = body["event"] as? [String: Any], event["id"] as? String == state?["id"] as? String,
                  let kind = event["kind"] as? String else { replyHandler(nil, "无效的面板事件"); return }
            if kind == "saving", let saving = event["saving"] as? Bool { relay(["id": state!["id"]!, "kind": kind, "saving": saving]) }
            else if kind == "select", wantsOpen, let value = event["value"] as? String, value.count <= 4096 { relay(["id": state!["id"]!, "kind": kind, "value": value]) }
            else { replyHandler(nil, "不可用的面板事件"); return }
        case "close": close(notify: true, restoreFocus: true)
        default: replyHandler(nil, "未知的面板操作"); return
        }
        replyHandler(true, nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(ModelPanelGeometry.sameOrigin(navigationAction.request.url, origin) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { close(notify: true) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { ready = false; measured = false; close(notify: true); webView.reload() }
}
#endif
