import AppKit

/// Position a DOM-anchored panel inside the display without clipping its controls.
public enum ModelPanelGeometry {
    public static func frame(anchor: NSRect, visible: NSRect, height: CGFloat) -> NSRect {
        let width = min(276, max(1, visible.width - 16))
        let height = min(max(80, height), min(420, max(1, visible.height - 16)))
        let x = min(max(anchor.maxX - width, visible.minX + 8), visible.maxX - width - 8)
        let above = anchor.maxY + 6
        let y = above + height <= visible.maxY - 8 ? above : anchor.minY - height - 6
        return NSRect(x: x, y: min(max(y, visible.minY + 8), visible.maxY - height - 8), width: width, height: height)
    }

    public static func sameOrigin(_ url: URL?, _ origin: URL) -> Bool {
        guard let url else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }
}
