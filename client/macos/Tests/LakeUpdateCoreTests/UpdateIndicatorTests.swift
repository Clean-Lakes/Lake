import AppKit
import LakeUpdateCore

@MainActor func testUpdateIndicator() {
    _ = NSApplication.shared
    let button = NSButton(frame: NSRect(x: 0, y: 0, width: 28, height: 28))
    let indicator = UpdateIndicator(button: button)
    indicator.display(version: nil, viewing: false)
    precondition(button.contentTintColor == .secondaryLabelColor)
    precondition(button.layer?.animation(forKey: UpdateIndicator.animationKey) == nil)
    indicator.display(version: "0.4.0", viewing: false)
    precondition(button.contentTintColor == .systemGreen)
    precondition(button.layer?.animation(forKey: UpdateIndicator.animationKey) != nil, "unseen update must pulse automatically")
    // Repeated background checks keep both the green signal and the running animation.
    indicator.display(version: "0.4.0", viewing: false)
    precondition(button.layer?.animation(forKey: UpdateIndicator.animationKey) != nil)
    indicator.display(version: "0.4.0", viewing: true)
    precondition(button.layer?.animation(forKey: UpdateIndicator.animationKey) == nil)
    indicator.display(version: "0.4.0", viewing: false)
    precondition(button.contentTintColor == .systemGreen)
    precondition(button.layer?.animation(forKey: UpdateIndicator.animationKey) == nil, "viewed update must not pulse again")
    indicator.display(version: "0.5.0", viewing: false)
    precondition(button.layer?.animation(forKey: UpdateIndicator.animationKey) != nil, "newer version must attract attention again")
    indicator.display(version: "0.5.0", viewing: false, reduceMotion: true)
    precondition(button.contentTintColor == .systemGreen)
    precondition(button.layer?.animation(forKey: UpdateIndicator.animationKey) == nil)
    indicator.display(version: "0.5.0", viewing: false, installing: true)
    precondition(button.layer?.animation(forKey: UpdateIndicator.animationKey) == nil)
    indicator.display(version: nil, viewing: false)
    precondition(button.contentTintColor == .secondaryLabelColor)
    precondition(button.layer?.animation(forKey: UpdateIndicator.animationKey) == nil)
    var attention = UpdateAttention()
    attention.markViewed("0.5.0")
    precondition(!attention.isUnread("0.4.0"))
    precondition(!attention.isUnread("0.5.0"))
    precondition(attention.isUnread("0.6.0"))
    precondition(!attention.isUnread("invalid"))
    print("Passed native update indicator: automatic green pulse, viewed/new version, install, reduced motion")
}
