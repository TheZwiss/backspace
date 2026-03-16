// Generates a squircle-masked dock icon for macOS dev mode.
// macOS only applies the squircle mask to packaged .app bundles,
// so app.dock.setIcon() needs a pre-masked PNG.

import AppKit

let src = NSImage(contentsOfFile: "build/icon.png")!
let size = src.size
let out = NSImage(size: size)

out.lockFocus()
let radius = size.width * 0.2237
let path = NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: radius, yRadius: radius)
path.addClip()
src.draw(in: NSRect(origin: .zero, size: size), from: NSRect(origin: .zero, size: size), operation: .sourceOver, fraction: 1.0)
out.unlockFocus()

let tiff = out.tiffRepresentation!
let rep = NSBitmapImageRep(data: tiff)!
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: "build/icon-dock.png"))
