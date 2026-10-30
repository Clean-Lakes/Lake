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
        precondition(above.width == 240 && above.maxX == bottom.maxX)
        let below = ModelPanelGeometry.frame(anchor: top, visible: visible, height: 420)
        precondition(below.maxY == top.minY - 6 && below.minX == visible.minX + 8 && below.width == 240)
        let oversized = ModelPanelGeometry.frame(anchor: NSRect(x: 80, y: 200, width: 1200, height: 28), visible: visible, height: 300)
        precondition(oversized.width == visible.width - 16 && visible.insetBy(dx: 8, dy: 8).contains(oversized))
        let screen = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let base = CGRect(x: 100, y: 50, width: 1200, height: 800)
        let pane = InspectorWindowExpansion(frame: base, visible: screen)
        precondition(pane.expanded == CGRect(x: 100, y: 50, width: 1582, height: 800))
        precondition(pane.closing(current: pane.expanded, minimumWidth: 850) == base)
        let edge = InspectorWindowExpansion(frame: CGRect(x: 700, y: 50, width: 1200, height: 800), visible: screen)
        precondition(edge.expanded.minX == 338 && edge.addedWidth == 382)
        precondition(edge.closing(current: edge.expanded, minimumWidth: 850).minX == 700)
        let wide = InspectorWindowExpansion(frame: CGRect(x: 0, y: 50, width: 1800, height: 800), visible: screen)
        precondition(wide.addedWidth == 120 && wide.expanded.width == 1920)
        let full = InspectorWindowExpansion(frame: screen, visible: screen, fullscreen: true)
        precondition(full.addedWidth == 0 && full.expanded == screen)
        let moved = CGRect(x: 50, y: 80, width: pane.expanded.width + 20, height: 820)
        precondition(pane.closing(current: moved, minimumWidth: 850) == CGRect(x: 50, y: 80, width: 1220, height: 820))
        let secondary = CGRect(x: -1920, y: 0, width: 1920, height: 1080)
        let otherScreen = InspectorWindowExpansion(frame: CGRect(x: -1400, y: 50, width: 1200, height: 800), visible: secondary)
        precondition(secondary.contains(otherScreen.expanded) && otherScreen.addedWidth == 382)
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
        print("Passed native macOS inspector expansion/restoration/screen bounds, panel placement/origin checks, hide/reopen, retained content, minimized restore and explicit termination checks")
    }
}
