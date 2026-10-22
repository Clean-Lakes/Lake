import AppKit
import LakeDesktopCore

@main struct WindowTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        let visible = NSRect(x: 100, y: 50, width: 900, height: 650)
        let bottom = NSRect(x: 900, y: 70, width: 90, height: 28)
        let top = NSRect(x: 110, y: 630, width: 100, height: 28)
        let above = ModelPanelGeometry.frame(anchor: bottom, visible: visible, height: 210)
        precondition(above.minY == bottom.maxY + 6 && visible.insetBy(dx: 8, dy: 8).contains(above))
        let below = ModelPanelGeometry.frame(anchor: top, visible: visible, height: 420)
        precondition(below.maxY == top.minY - 6 && below.minX == visible.minX + 8)
        let origin = URL(string: "http://127.0.0.1:8000/")!
        precondition(ModelPanelGeometry.sameOrigin(URL(string: "http://127.0.0.1:8000/?panel=1"), origin))
        for candidate in ["https://127.0.0.1:8000/", "http://127.0.0.1:8001/", "http://localhost:8000/", "https://example.com/"] {
            precondition(!ModelPanelGeometry.sameOrigin(URL(string: candidate), origin))
        }
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
        print("Passed native macOS panel placement/origin checks, hide/reopen, retained content, minimized restore and explicit termination checks")
    }
}
