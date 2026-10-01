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

let background = NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 225, yRadius: 225)
NSGradient(starting: NSColor(calibratedRed: 0.18, green: 0.28, blue: 0.60, alpha: 1),
           ending: NSColor(calibratedRed: 0.10, green: 0.17, blue: 0.40, alpha: 1))!
    .draw(in: background, angle: -50)

NSColor(calibratedWhite: 1, alpha: 0.96).setStroke()
let top = NSBezierPath(ovalIn: NSRect(x: 257, y: 594, width: 510, height: 164))
top.lineWidth = 39
top.stroke()

let vessel = NSBezierPath()
vessel.lineWidth = 39
vessel.lineCapStyle = .round
vessel.move(to: NSPoint(x: 257, y: 676))
vessel.line(to: NSPoint(x: 257, y: 360))
vessel.curve(to: NSPoint(x: 767, y: 360),
             controlPoint1: NSPoint(x: 257, y: 224),
             controlPoint2: NSPoint(x: 767, y: 224))
vessel.line(to: NSPoint(x: 767, y: 676))
vessel.stroke()

let middle = NSBezierPath()
middle.lineWidth = 31
middle.lineCapStyle = .round
middle.move(to: NSPoint(x: 260, y: 501))
middle.curve(to: NSPoint(x: 764, y: 501),
             controlPoint1: NSPoint(x: 260, y: 372),
             controlPoint2: NSPoint(x: 764, y: 372))
middle.stroke()

NSColor(calibratedRed: 0.35, green: 0.88, blue: 0.72, alpha: 1).setFill()
NSBezierPath(ovalIn: NSRect(x: 680, y: 694, width: 89, height: 89)).fill()

graphics.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("无法编码 PNG") }
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
