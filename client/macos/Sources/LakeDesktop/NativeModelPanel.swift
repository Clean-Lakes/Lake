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

@MainActor private final class ProviderListWindow: NSPanel {
    var handleKey: (NSEvent) -> Bool = { _ in false }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown && handleKey(event) { return }
        super.sendEvent(event)
    }
}

@MainActor private final class ProviderChoiceButton: NSButton {
    var hovered = false { didSet { needsDisplay = true } }
    var checked = false
    var entered: (() -> Void)?
    private var area: NSTrackingArea?
    override func updateTrackingAreas() {
        if let area { removeTrackingArea(area) }
        area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area!)
        super.updateTrackingAreas()
    }
    override func mouseEntered(with event: NSEvent) { entered?() }
    override func mouseExited(with event: NSEvent) { hovered = false }
    override func draw(_ dirtyRect: NSRect) {
        if hovered { NSColor.unemphasizedSelectedContentBackgroundColor.setFill(); NSBezierPath(roundedRect: bounds, xRadius: 9, yRadius: 9).fill() }
        let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byTruncatingTail
        (title as NSString).draw(in: NSRect(x: 10, y: (bounds.height - 17) / 2, width: bounds.width - 40, height: 17), withAttributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph])
        if checked, let image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)?.withSymbolConfiguration(.init(paletteColors: [.labelColor])) { image.draw(in: NSRect(x: bounds.width - 24, y: (bounds.height - 13) / 2, width: 13, height: 13)) }
    }
}

/// Opaque supplier menu: no visual effect view, vibrancy or background sampling.
@MainActor private final class OpaqueProviderList {
    let window: ProviderListWindow
    private weak var parent: NSPanel?
    private var buttons: [ProviderChoiceButton] = []
    private var values: [String] = []
    private var active = 0
    private var completion: ((String?) -> Void)?
    init(parent: NSPanel, providers: [[String: String]], current: String?, header: NSRect, completion: @escaping (String?) -> Void) {
        self.parent = parent; self.completion = completion
        let width: CGFloat = 208
        let desired = CGFloat(providers.count + 1) * 32 + 19
        let visible = (parent.screen ?? NSScreen.main!).visibleFrame
        let height = min(desired, min(420, visible.height - 16))
        let preferred = parent.frame.minX - width - 6 >= visible.minX + 8 ? parent.frame.minX - width - 6 : parent.frame.maxX + 6
        let frame = NSRect(x: min(max(preferred, visible.minX + 8), visible.maxX - width - 8), y: min(max(header.maxY - height, visible.minY + 8), visible.maxY - height - 8), width: width, height: height)
        window = ProviderListWindow(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.title = "模型供应商"; window.appearance = parent.appearance
        window.backgroundColor = .clear; window.isOpaque = false; window.hasShadow = true; window.isReleasedWhenClosed = false; window.level = .floating
        let surface = NSView(frame: NSRect(origin: .zero, size: frame.size)); surface.wantsLayer = true
        window.effectiveAppearance.performAsCurrentDrawingAppearance {
            surface.layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
            surface.layer?.borderColor = NSColor.separatorColor.cgColor
        }
        surface.layer?.cornerRadius = 18; surface.layer?.cornerCurve = .continuous; surface.layer?.masksToBounds = true
        surface.layer?.borderWidth = 1 / (parent.screen?.backingScaleFactor ?? 2)
        surface.setAccessibilityRole(.menu); surface.setAccessibilityLabel("模型供应商")
        window.contentView = surface
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 0; stack.edgeInsets = NSEdgeInsets(top: 5, left: 5, bottom: 5, right: 5)
        for (index, provider) in (providers + [["id": "__settings__", "name": "管理模型"]]).enumerated() {
            if index == providers.count {
                let separator = NSBox(); separator.boxType = .separator
                separator.widthAnchor.constraint(equalToConstant: width - 10).isActive = true
                separator.heightAnchor.constraint(equalToConstant: 9).isActive = true
                stack.addArrangedSubview(separator)
            }
            let button = ProviderChoiceButton(title: provider["name"] ?? "供应商", target: nil, action: nil)
            button.isBordered = false; button.focusRingType = .none; button.checked = provider["id"] == current
            button.setAccessibilityRole(.menuItem); button.setAccessibilityValue(button.checked ? "已选择" : "")
            button.target = self; button.action = #selector(choose(_:)); button.tag = index
            button.entered = { [weak self] in self?.focus(index) }
            button.widthAnchor.constraint(equalToConstant: width - 10).isActive = true
            button.heightAnchor.constraint(equalToConstant: 32).isActive = true
            buttons.append(button); values.append(provider["id"] ?? "")
            stack.addArrangedSubview(button)
            if button.checked { active = index }
        }
        stack.frame = NSRect(x: 0, y: 0, width: width, height: desired)
        let scroll = NSScrollView(frame: surface.bounds); scroll.autoresizingMask = [.width, .height]; scroll.drawsBackground = false
        // NSScrollView's default bezel otherwise adds a second rim inside the panel.
        scroll.borderType = .noBorder; scroll.focusRingType = .none
        scroll.contentView.drawsBackground = false
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true; scroll.documentView = stack
        surface.addSubview(scroll)
        window.handleKey = { [weak self] event in
            guard let self else { return false }
            switch event.keyCode {
            case 125: self.focus((self.active + 1) % self.buttons.count)
            case 126: self.focus((self.active + self.buttons.count - 1) % self.buttons.count)
            case 115: self.focus(0)
            case 119: self.focus(self.buttons.count - 1)
            case 36, 76, 49: self.close(value: self.values[self.active])
            case 53, 48: self.close()
            default: return false
            }
            return true
        }
        parent.addChildWindow(window, ordered: .above); window.makeKeyAndOrderFront(nil); window.invalidateShadow(); focus(active)
    }
    private func focus(_ index: Int) {
        active = index
        for (i, button) in buttons.enumerated() { button.hovered = i == index }
        window.makeFirstResponder(buttons[index]); buttons[index].scrollToVisible(buttons[index].bounds)
    }
    @objc private func choose(_ sender: NSButton) { close(value: values[sender.tag]) }
    func close(value: String? = nil, restoringFocus: Bool = true) {
        guard let completion else { return }; self.completion = nil
        parent?.removeChildWindow(window); window.orderOut(nil)
        if restoringFocus { parent?.makeKeyAndOrderFront(nil) }
        completion(value)
    }
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
    private var anchorOnScreen = NSRect.zero
    private var providerList: OpaqueProviderList?
    private var providerHeader = NSRect.zero
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
        let initialFrame = NSRect(x: 0, y: 0, width: 276, height: 220)
        panel = ModelPanelWindow(contentRect: initialFrame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = webView.configuration.websiteDataStore
        configuration.userContentController.addUserScript(Self.bridge(role: "panel"))
        content = TransparentPanelWebView(frame: initialFrame, configuration: configuration)
        super.init()
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "lakeModelPanel")
        content.navigationDelegate = self
        content.underPageBackgroundColor = .clear
        content.focusRingType = .none
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.clear.cgColor
        content.layer?.cornerRadius = 18
        content.layer?.cornerCurve = .continuous
        content.layer?.masksToBounds = true
        content.setAccessibilityLabel("模型与思考强度")
        content.autoresizingMask = [.width, .height]
        let glass = NSGlassEffectView(frame: initialFrame)
        glass.wantsLayer = true
        glass.layer?.backgroundColor = NSColor.clear.cgColor
        glass.layer?.cornerRadius = 18
        glass.layer?.cornerCurve = .continuous
        glass.layer?.masksToBounds = true
        glass.layerContentsRedrawPolicy = .duringViewResize
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
        anchorOnScreen = onScreen
        panel.setFrame(ModelPanelGeometry.frame(anchor: onScreen, visible: screen.visibleFrame, height: height), display: true)
        panel.invalidateShadow()
    }

    private func present() {
        guard wantsOpen, let parent, parent.isVisible, !parent.isMiniaturized else { return }
        if !panel.isVisible {
            parent.addChildWindow(panel, ordered: .above)
            panel.makeKeyAndOrderFront(nil)
            panel.makeFirstResponder(content)
            localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) { [weak self] event in
                guard let self else { return event }
                if let providerList = self.providerList {
                    if event.type == .keyDown || event.window === providerList.window { return event }
                    let headerClick = event.window === self.panel && self.providerHeader.contains(NSEvent.mouseLocation)
                    providerList.close(restoringFocus: false)
                    if headerClick { return nil }
                }
                if event.type == .leftMouseDown && event.window === self.parent && self.anchorOnScreen.contains(NSEvent.mouseLocation) {
                    // Consume the trigger click: otherwise the web click can reopen the panel after this close.
                    self.close(notify: true, restoreFocus: true)
                    return nil
                }
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
        providerList?.close(restoringFocus: false)
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

    private func showProviders(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard wantsOpen, providerList == nil, let providers = body["providers"] as? [[String: String]],
              !providers.isEmpty, providers.count <= 128,
              providers.allSatisfy({ $0["id"] != nil && ($0["id"]?.count ?? 0) <= 1024 && ($0["name"]?.count ?? 0) <= 256 }),
              let anchor = body["anchor"] as? [String: Double], let left = anchor["left"], let top = anchor["top"], let width = anchor["width"], let height = anchor["height"],
              [left, top, width, height].allSatisfy({ $0.isFinite }), left >= 0, top >= 0, width > 0, height > 0,
              left + width <= content.bounds.width + 1, top + height <= content.bounds.height + 1 else { reply(NSNull(), nil); return }
        let rect = NSRect(x: left, y: content.isFlipped ? top : content.bounds.height - top - height, width: width, height: height)
        providerHeader = panel.convertToScreen(content.convert(rect, to: nil))
        providerList = OpaqueProviderList(parent: panel, providers: providers, current: body["value"] as? String, header: providerHeader) { [weak self] value in
            self?.providerList = nil
            reply(value.map { $0 as Any } ?? NSNull(), nil)
        }
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
        case "providers": showProviders(body, reply: replyHandler); return
        case "event":
            guard let event = body["event"] as? [String: Any], event["id"] as? String == state?["id"] as? String,
                  let kind = event["kind"] as? String else { replyHandler(nil, "无效的面板事件"); return }
            if kind == "saving", let saving = event["saving"] as? Bool { relay(["id": state!["id"]!, "kind": kind, "saving": saving, "session": event["session"] as? String ?? ""]) }
            else if kind == "settings", wantsOpen { relay(["id": state!["id"]!, "kind": kind]) }
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
