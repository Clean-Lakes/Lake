import AppKit
import CoreVideo
import QuartzCore

@MainActor final class WindowDisplayClock: NSObject {
    private weak var window: NSWindow?
    private var onFrame: ((CFTimeInterval) -> Void)?
    private var stopDriver: (() -> Void)?
    private var configureScreen: ((NSScreen) -> Bool)?

    init(window: NSWindow, onFrame: @escaping (CFTimeInterval) -> Void) {
        self.window = window
        self.onFrame = onFrame
    }

    func start() -> Bool {
        guard let window, let screen = window.screen else { return false }
        if #available(macOS 14, *) {
            let link = window.displayLink(target: self, selector: #selector(displayFrame(_:)))
            configureScreen = { screen in
                let maximum = Float(screen.maximumFramesPerSecond)
                link.preferredFrameRateRange = maximum > 0
                    ? CAFrameRateRange(minimum: maximum, maximum: maximum, preferred: maximum)
                    : .default
                return true
            }
            _ = configureScreen?(screen)
            stopDriver = { link.invalidate() }
            link.add(to: .main, forMode: .common)
            return true
        }
        return startCoreVideo(on: screen)
    }

    func followWindowScreen() -> Bool {
        guard let screen = window?.screen else { return false }
        return configureScreen?(screen) ?? false
    }

    func invalidate() {
        onFrame = nil
        stopDriver?()
        stopDriver = nil
        configureScreen = nil
    }

    @available(macOS 14, *)
    @objc private func displayFrame(_ link: CADisplayLink) {
        onFrame?(link.targetTimestamp)
    }

    // Core Video supplies display ticks on macOS 13. Coalesce them on the main
    // queue so an occupied UI thread never accumulates a queue of stale frames.
    @available(macOS, deprecated: 15)
    private func startCoreVideo(on screen: NSScreen) -> Bool {
        guard let display = screen.displayID else { return false }
        var output: CVDisplayLink?
        guard CVDisplayLinkCreateWithCGDisplay(display, &output) == kCVReturnSuccess, let output else { return false }
        let delivery = DispatchSource.makeUserDataAddSource(queue: .main)
        delivery.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.onFrame?(CACurrentMediaTime()) }
        }
        delivery.activate()
        guard CVDisplayLinkSetOutputHandler(output, { _, _, _, _, _ in
            delivery.add(data: 1)
            return kCVReturnSuccess
        }) == kCVReturnSuccess, CVDisplayLinkStart(output) == kCVReturnSuccess else {
            delivery.cancel()
            return false
        }
        var currentDisplay = display
        configureScreen = { screen in
            guard let next = screen.displayID else { return false }
            guard next != currentDisplay else { return true }
            guard CVDisplayLinkSetCurrentCGDisplay(output, next) == kCVReturnSuccess else { return false }
            currentDisplay = next
            return true
        }
        stopDriver = {
            CVDisplayLinkStop(output)
            delivery.cancel()
        }
        return true
    }
}

private extension NSScreen {
    var displayID: CGDirectDisplayID? {
        (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }
}
