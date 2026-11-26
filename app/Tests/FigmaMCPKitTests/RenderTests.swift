import XCTest
import SwiftUI
import AppKit
@testable import FigmaMCPKit

/// Renders key states to PNG so a human can look at them. Output: $FIGMAMCP_SHOTS_DIR or the temp dir.
@MainActor
final class RenderTests: XCTestCase {
    var outDir: URL {
        let p = ProcessInfo.processInfo.environment["FIGMAMCP_SHOTS_DIR"] ?? NSTemporaryDirectory() + "figmamcp-shots"
        let u = URL(fileURLWithPath: p); try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true); return u
    }

    func render<V: View>(_ name: String, _ view: V, scheme: ColorScheme) throws {
        let r = ImageRenderer(content: view.environment(\.colorScheme, scheme))
        r.scale = 2
        guard let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return XCTFail("render \(name)") }
        try png.write(to: outDir.appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png"))
        XCTAssertGreaterThan(rep.pixelsWide, 100)
    }

    func shots() throws {
        let first: [(String, Snapshot)] = [
            ("1-install-figma", Fixture.snapshot("nofigma")),
            ("2-connect-ai", Fixture.snapshot("noai")),
            ("3-add-to-figma", Fixture.snapshot("fresh")),
            ("3b-figma-first-open", Fixture.snapshot("neverlaunched", running: false)),
            ("3c-figma-first-opening", Fixture.snapshot("neverlaunched", running: true)),
            ("4-allow-opening", Fixture.snapshot("ready")),
            ("5-open-auto", Fixture.snapshot("ready", access: true)),
            ("5b-open-manual", Fixture.snapshot("ready", skipped: true)),
            ("5c-open-figma-closed", Fixture.snapshot("ready", skipped: true, running: false)),
            ("6-done", Fixture.snapshot("ready", access: true, seen: true)),
            ("6b-done-skipped", Fixture.snapshot("fresh", skipped: true, openSkipped: true)),
            ("5d-open-outdated", Fixture.snapshot("outdated", access: true)),
            ("6c-done-not-loaded", Fixture.snapshot("notloaded", access: true, seen: true)),
            ("6d-done-working", Fixture.snapshot("working", access: true, seen: true)),
        ]
        let pops: [(String, Snapshot)] = [
            ("pop-ready", Fixture.snapshot("ready", access: true)),
            ("pop-closed", Fixture.snapshot("ready", access: true, running: false)),
            ("pop-attention", Fixture.snapshot("broken")),
            ("pop-first-open", Fixture.snapshot("neverlaunched", running: false)),
            ("pop-outdated", Fixture.snapshot("outdated", access: true, seen: true)),
            ("pop-not-loaded", Fixture.snapshot("notloaded", access: true, seen: true)),
            ("pop-working", Fixture.snapshot("working", access: true, seen: true)),
        ]
        for scheme in [ColorScheme.light, .dark] {
            for (n, s) in first { try render(n, FirstRunView(model: .preview(s)), scheme: scheme) }
            for (n, s) in pops { try render(n, PopoverView(model: .preview(s)), scheme: scheme) }
            let g = AppModel.preview(Fixture.snapshot("ready")); g.showAccessGuide = true
            try render("pop-access-guide", PopoverView(model: g), scheme: scheme)
        }
    }

    func testRenderKeyStates() throws { try shots() }

    func testRenderKeyStatesInChinese() throws {
        L10n.lang = .zh; defer { L10n.lang = .en }
        let base = outDir
        let zh = base.appendingPathComponent("zh"); try? FileManager.default.createDirectory(at: zh, withIntermediateDirectories: true)
        for (n, s) in [("3-add-to-figma", Fixture.snapshot("fresh")), ("4-allow-opening", Fixture.snapshot("ready")),
                       ("5b-open-manual", Fixture.snapshot("ready", skipped: true)), ("6c-done-not-loaded", Fixture.snapshot("notloaded", access: true, seen: true))] {
            try render("zh/\(n)", FirstRunView(model: .preview(s)), scheme: .light)
        }
        try render("zh/pop-not-loaded", PopoverView(model: .preview(Fixture.snapshot("notloaded", access: true, seen: true))), scheme: .light)
    }
}
