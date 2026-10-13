import AppKit

let size = 1024
guard CommandLine.arguments.count == 2,
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
      ),
      let graphics = NSGraphicsContext(bitmapImageRep: bitmap)
else { fatalError("无法创建应用图标") }

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphics
graphics.imageInterpolation = .high

// Keep the approved artwork intact; only apply the native app-icon silhouette.
let sourceURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("assets/branding/lake-app-icon.png")
guard let artwork = NSImage(contentsOf: sourceURL) else {
    fatalError("无法读取 Lake 图标母版：\(sourceURL.path)")
}
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: size, height: size).fill(using: .copy)
let tile = NSRect(x: 88, y: 88, width: 848, height: 848)
NSBezierPath(roundedRect: tile, xRadius: 190, yRadius: 190).addClip()
artwork.draw(in: tile, from: .zero, operation: .sourceOver, fraction: 1)

graphics.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("无法编码 PNG") }
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
