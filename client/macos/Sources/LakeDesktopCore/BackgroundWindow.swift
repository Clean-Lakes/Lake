import AppKit

@MainActor public enum BackgroundWindow {
    // Keep the same window, WebView and backend alive. Explicit application
    // termination and the updater continue through the normal shutdown path.
    public static func shouldClose(_ window: NSWindow, terminating: Bool) -> Bool {
        if terminating { return true }
        window.orderOut(nil)
        return false
    }

    public static func show(_ window: NSWindow) {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
