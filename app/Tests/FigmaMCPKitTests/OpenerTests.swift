import XCTest
@testable import FigmaMCPKit

final class FakeMenu: FigmaMenuAccess {
    var isTrusted = true, figmaInstalled = true
    var menuAppearsAfter = 0       // polls before "Plugins" exists; Int.max = never
    var pressResult = true
    var polls = 0, activated = 0
    var pressed: [[String]] = []
    func activateFigma() { activated += 1 }
    func hasMenuBarItem(_ title: String) -> Bool { polls += 1; return polls > menuAppearsAfter }
    func press(path: [String]) -> Bool { pressed.append(path); return pressResult }
}

final class OpenerTests: XCTestCase {
    func opener(_ m: FakeMenu) -> PluginOpener { PluginOpener(access: m, waitForMenu: 0.5, pollInterval: 0.01) }

    func testOpensAfterMenuAppears() async {
        let m = FakeMenu(); m.menuAppearsAfter = 3
        let r = await opener(m).open()
        XCTAssertEqual(r, .opened)
        XCTAssertEqual(m.activated, 1)
        XCTAssertEqual(m.pressed, [["Plugins", "Development", "FigmaMCP"]])
    }

    func testNoFileOpenWhenMenuNeverAppears() async {
        let m = FakeMenu(); m.menuAppearsAfter = .max
        let r = await opener(m).open()
        XCTAssertEqual(r, .noFileOpen)
        XCTAssertTrue(m.pressed.isEmpty)
    }

    func testAccessDeniedDoesNotTouchFigma() async {
        let m = FakeMenu(); m.isTrusted = false
        let r = await opener(m).open()
        XCTAssertEqual(r, .accessDenied)
        XCTAssertEqual(m.activated, 0)
    }

    func testFigmaMissingAndItemMissing() async {
        let a = FakeMenu(); a.figmaInstalled = false
        let ra = await opener(a).open()
        XCTAssertEqual(ra, .figmaNotInstalled)
        let b = FakeMenu(); b.pressResult = false
        let rb = await opener(b).open()
        XCTAssertEqual(rb, .menuItemMissing)
    }

    func testOutcomeJSON() {
        XCTAssertEqual(OpenOutcome.opened.json["ok"] as? Bool, true)
        XCTAssertEqual(OpenOutcome.noFileOpen.json["outcome"] as? String, "no-file-open")
        XCTAssertEqual(OpenOutcome.noFileOpen.json["ok"] as? Bool, false)
    }
}
