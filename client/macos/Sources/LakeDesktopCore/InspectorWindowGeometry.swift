import Foundation

/// Adds a right-hand pane without reducing the original workbench when the screen permits.
public struct InspectorWindowExpansion {
    public let original: CGRect
    public let expanded: CGRect
    public var addedWidth: CGFloat { expanded.width - original.width }

    public init(frame: CGRect, visible: CGRect, width: CGFloat = 382, fullscreen: Bool = false) {
        original = frame
        let growth = fullscreen ? 0 : max(0, min(width, visible.width - frame.width))
        expanded = CGRect(x: growth > 0 ? min(frame.minX, visible.maxX - frame.width - growth) : frame.minX,
                          y: frame.minY, width: frame.width + growth, height: frame.height)
    }

    /// Keep a user's move/resize; only remove the width this pane actually added.
    public func closing(current: CGRect, minimumWidth: CGFloat) -> CGRect {
        let width = max(minimumWidth, current.width - addedWidth)
        let unchanged = abs(current.minX - expanded.minX) < 1 && abs(current.width - expanded.width) < 1
        return CGRect(x: unchanged ? original.minX : current.minX, y: current.minY,
                      width: width, height: current.height)
    }
}
