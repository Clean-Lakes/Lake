import AppKit

/// Position a DOM-anchored panel inside the display without clipping its controls.
public enum ModelPanelGeometry {
    public static func frame(anchor: NSRect, visible: NSRect, height: CGFloat) -> NSRect {
        let width = min(max(240, anchor.width), max(1, visible.width - 16))
        let height = min(max(80, height), min(420, max(1, visible.height - 16)))
        let x = min(max(anchor.maxX - width, visible.minX + 8), visible.maxX - width - 8)
        let above = anchor.maxY + 6
        let y = above + height <= visible.maxY - 8 ? above : anchor.minY - height - 6
        return NSRect(x: x, y: min(max(y, visible.minY + 8), visible.maxY - height - 8), width: width, height: height)
    }

    /// The reveal starts at the actual trigger edge, even when the panel is clamped by the display.
    public static func revealBounds(panel: NSRect, anchor: NSRect, progress: CGFloat) -> NSRect {
        let width = min(panel.width, anchor.width), height = min(panel.height, anchor.height)
        let anchorY = panel.midY >= anchor.midY ? anchor.maxY : anchor.minY - height
        let x = min(max(anchor.maxX - width - panel.minX, 0), panel.width - width)
        let y = min(max(anchorY - panel.minY, 0), panel.height - height)
        let remaining = 1 - progress
        return NSRect(x: x * remaining, y: y * remaining,
                      width: width + (panel.width - width) * progress,
                      height: height + (panel.height - height) * progress)
    }

    public static func sameOrigin(_ url: URL?, _ origin: URL) -> Bool {
        guard let url else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }
}
