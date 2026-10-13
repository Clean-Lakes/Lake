import AppKit
import QuartzCore

/// Remember the version the user actually viewed, across periodic checks and errors.
public struct UpdateAttention {
    private var viewed: Version?
    public init() {}
    public mutating func markViewed(_ version: String?) {
        guard let text = version, let value = Version(text) else { return }
        if viewed == nil || value > viewed! { viewed = value }
    }
    public func isUnread(_ version: String?) -> Bool {
        guard let text = version, let value = Version(text) else { return false }
        return viewed == nil || value > viewed!
    }
}

@MainActor public final class UpdateIndicator {
    public static let animationKey = "lake.updateAvailable"
    private let button: NSButton
    private var attention = UpdateAttention()

    public init(button: NSButton) {
        self.button = button
        button.wantsLayer = true
        button.layer?.cornerRadius = 6
    }

    public func display(version: String?, viewing: Bool, installing: Bool = false, reduceMotion: Bool = false) {
        if viewing { attention.markViewed(version) }
        let available = version.flatMap(Version.init) != nil
        button.contentTintColor = available ? .systemGreen : .secondaryLabelColor
        // Give the symbol an explicit palette: toolbar vibrancy can gray template images.
        let image = NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: available ? "发现新版本" : "检测更新")
        button.image = available ? image?.withSymbolConfiguration(.init(paletteColors: [.systemGreen])) ?? image : image
        button.layer?.backgroundColor = available ? NSColor.systemGreen.withAlphaComponent(0.14).cgColor : NSColor.clear.cgColor
        let pulse = attention.isUnread(version) && !viewing && !installing && !reduceMotion
        if pulse {
            if button.layer?.animation(forKey: Self.animationKey) == nil {
                let animation = CABasicAnimation(keyPath: "opacity")
                animation.fromValue = 1
                animation.toValue = 0.35
                animation.duration = 0.8
                animation.autoreverses = true
                animation.repeatCount = .infinity
                animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                button.layer?.add(animation, forKey: Self.animationKey)
            }
        } else {
            button.layer?.removeAnimation(forKey: Self.animationKey)
        }
        button.layer?.opacity = 1
    }
}
