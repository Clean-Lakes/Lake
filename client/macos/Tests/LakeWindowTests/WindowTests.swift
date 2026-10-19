import AppKit
import LakeDesktopCore

@main struct WindowTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 400, height: 260),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let content = NSView()
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        for _ in 0..<3 {
            precondition(!BackgroundWindow.shouldClose(window, terminating: false))
            precondition(!window.isVisible && window.contentView === content)
            BackgroundWindow.show(window)
            precondition(window.isVisible && window.contentView === content)
        }
        window.miniaturize(nil)
        BackgroundWindow.show(window)
        precondition(window.isVisible && !window.isMiniaturized)
        precondition(BackgroundWindow.shouldClose(window, terminating: true))
        window.close()
        print("Passed native macOS hide/reopen, retained content, minimized restore and explicit termination checks")
    }
}
