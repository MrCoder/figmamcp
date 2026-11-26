import XCTest
@testable import FigmaMCPKit

final class FlowTests: XCTestCase {
    func testNoReportIsCheckingOrProblem() {
        XCTAssertEqual(Flow.stage(Snapshot()), .checking)
        XCTAssertEqual(Flow.stage(Snapshot(engineError: "x")), .engineProblem)
    }

    func testStageOrder() {
        XCTAssertEqual(Flow.stage(Fixture.snapshot("nofigma")), .installFigma)
        XCTAssertEqual(Flow.stage(Fixture.snapshot("noai")), .connectAI)
        XCTAssertEqual(Flow.stage(Fixture.snapshot("fresh")), .addToFigma)
        XCTAssertEqual(Flow.stage(Fixture.snapshot("ready")), .allowOpening)
        // Owner feedback 2026-11-10: setup ends only after FigmaMCP was seen open in a Figma file.
        XCTAssertEqual(Flow.stage(Fixture.snapshot("ready", access: true)), .openInFigma)
        XCTAssertEqual(Flow.stage(Fixture.snapshot("ready", skipped: true)), .openInFigma)
        XCTAssertEqual(Flow.stage(Fixture.snapshot("ready", access: true, seen: true)), .done)
        XCTAssertEqual(Flow.stage(Fixture.snapshot("ready", skipped: true, openSkipped: true)), .done)
    }

    func testFigmaRestartsOnlyWhenTheAddOnIsMissing() {
        XCTAssertTrue(Flow.needsFigmaRestart(Fixture.snapshot("fresh", running: true)))
        XCTAssertFalse(Flow.needsFigmaRestart(Fixture.snapshot("fresh", running: false)))
        XCTAssertFalse(Flow.needsFigmaRestart(Fixture.snapshot("ready", running: true)))
    }

    // Figma installed but never opened: it has no settings file yet, so adding FigmaMCP cannot work
    // until Figma has opened once. The user must be told to open Figma, not to "Add" or restart it.
    func testFigmaNeverOpenedAsksToOpenFigmaFirst() {
        let closed = Fixture.snapshot("neverlaunched", running: false)
        let open = Fixture.snapshot("neverlaunched", running: true)
        XCTAssertTrue(Flow.needsFigmaFirstOpen(closed))
        XCTAssertTrue(Flow.needsFigmaFirstOpen(open))
        XCTAssertFalse(Flow.needsFigmaRestart(open))
        XCTAssertFalse(Flow.needsFigmaFirstOpen(Fixture.snapshot("fresh", running: false)))
        XCTAssertFalse(Flow.needsFigmaFirstOpen(Fixture.snapshot("ready", running: true)))
        let addon = Flow.health(closed).first { $0.kind == .addon }
        XCTAssertEqual(addon?.fix, .launchFigma)
        XCTAssertEqual(addon?.fixLabel, "Open Figma")
        XCTAssertNil(Flow.health(open).first { $0.kind == .addon }?.fix)
    }

    func testOnlyAFinishedSetupIsUpdatedQuietly() {
        XCTAssertTrue(Flow.needsQuietUpdate(Fixture.snapshot("appupdated")))
        for name in ["fresh", "nofigma", "noai", "ready", "broken", "neverlaunched", "codexbroken"] {
            XCTAssertFalse(Flow.needsQuietUpdate(Fixture.snapshot(name)), name)
        }
    }

    // One AI app that cannot be connected must not trap setup when another works (2026-11-10 report).
    func testOneBrokenAIDoesNotBlockSetup() {
        XCTAssertEqual(Flow.stage(Fixture.snapshot("codexbroken")), .allowOpening)
        XCTAssertEqual(Flow.stage(Fixture.snapshot("codexbroken", access: true, seen: true)), .done)
        let ai = Flow.health(Fixture.snapshot("codexbroken")).first { $0.kind == .ai }
        XCTAssertEqual(ai?.health, .needsFix)
        XCTAssertEqual(ai?.detail, "Claude Code set up. Codex is not set up yet")
    }

    func testBrokenBackgroundSendsUserBackToAddStep() {
        XCTAssertEqual(Flow.stage(Fixture.snapshot("broken", access: true)), .addToFigma)
    }

    func testChecklistTicks() {
        let t = Flow.checklist(Fixture.snapshot("fresh")).map(\.tick)
        XCTAssertEqual(t, [.done, .done, .current, .waiting, .waiting])
        let open = Flow.checklist(Fixture.snapshot("ready", skipped: true)).map(\.tick)
        XCTAssertEqual(open, [.done, .done, .done, .skipped, .current])
        let done = Flow.checklist(Fixture.snapshot("ready", skipped: true, seen: true)).map(\.tick)
        XCTAssertEqual(done, [.done, .done, .done, .skipped, .done])
        XCTAssertEqual(Flow.checklist(Fixture.snapshot("nofigma")).map(\.tick), [.current, .waiting, .waiting, .waiting, .waiting])
    }

    func testPluginOpenComesFromTheReport() {
        XCTAssertTrue(Flow.pluginOpen(Fixture.report("ready")))      // currentFile "Checkout flow"
        XCTAssertFalse(Flow.pluginOpen(Fixture.report("fresh")))
    }

    func testAPanelFromAnOlderVersionDoesNotCountAsOpen() {
        let r = Fixture.report("outdated")
        XCTAssertFalse(Flow.pluginOpen(r))
        XCTAssertEqual(Flow.outdatedFiles(r), ["Conf App"])
        XCTAssertEqual(Flow.stage(Fixture.snapshot("outdated", access: true)), .openInFigma)
    }

    func testAPanelFromAnOlderVersionIsShownAsNeedingAFix() {
        let s = Fixture.snapshot("outdated", access: true, seen: true)
        let item = Flow.health(s).first { $0.kind == .open }
        XCTAssertEqual(item?.health, .needsFix)
        XCTAssertEqual(item?.detail, "FigmaMCP in \u{201C}Conf App\u{201D} is from an older version. Close it and open it again.")
        XCTAssertEqual(Flow.menuStatus(s), .needsAttention)
        XCTAssertNil(Flow.health(Fixture.snapshot("ready", access: true, seen: true)).first { $0.kind == .open })
    }

    func testTrySentenceNamesFigmaFigmaMCPAndTheFile() {
        XCTAssertEqual(Flow.trySentence(file: "Checkout flow"),
                       "Use FigmaMCP to look at my open Figma file \u{201C}Checkout flow\u{201D} and suggest three ways to improve the layout. Don't change anything yet.")
        XCTAssertEqual(Flow.trySentence(file: nil),
                       "Use FigmaMCP to look at my open Figma file and suggest three ways to improve the layout. Don't change anything yet.")
    }

    func testDoneNamesOnlyConnectedAI() {
        XCTAssertEqual(Flow.connectedAINames(Fixture.report("codexbroken")), ["Claude Code"])
        XCTAssertEqual(Flow.connectedAINames(Fixture.report("ready")), ["Claude Code", "Codex"])
    }

    func testHealthOffersOneClickFix() {
        let items = Flow.health(Fixture.snapshot("fresh"))
        XCTAssertEqual(items.first { $0.kind == .addon }?.fix, .setUp)
        XCTAssertEqual(items.first { $0.kind == .ai }?.fix, .setUp)
        XCTAssertEqual(Flow.health(Fixture.snapshot("nofigma")).first { $0.kind == .figma }?.fix, .installFigma)
        XCTAssertEqual(Flow.health(Fixture.snapshot("noai")).first { $0.kind == .ai }?.fix, .openAIHelp)
    }

    func testHealthHidesJargonFromEngineText() {
        let items = Flow.health(Fixture.snapshot("broken"))
        let addon = items.first { $0.kind == .addon }!
        XCTAssertEqual(addon.health, .needsFix)
        XCTAssertFalse(addon.detail.lowercased().contains("port"))
    }

    func testMenuStatus() {
        XCTAssertEqual(Flow.menuStatus(Fixture.snapshot("ready", access: true)), .ready)
        XCTAssertEqual(Flow.menuStatus(Fixture.snapshot("ready", access: true, running: false)), .figmaClosed)
        XCTAssertEqual(Flow.menuStatus(Fixture.snapshot("broken", access: true)), .needsAttention)
        XCTAssertEqual(Flow.menuStatus(Fixture.snapshot("fresh")), .needsAttention)
        // Not allowing Accessibility is optional: it must not turn the icon to "needs attention".
        XCTAssertEqual(Flow.menuStatus(Fixture.snapshot("ready", access: false)), .ready)
    }

    func testUserFacingCopyHasNoJargon() {
        let banned = ["port", "relay", "channel", "mcp", "manifest", "plugin"]
        for name in ["fresh", "nofigma", "noai", "ready", "broken", "neverlaunched", "appupdated"] {
            for a in [true, false] {
                for i in Flow.health(Fixture.snapshot(name, access: a)) {
                    let text = (i.title + " " + i.detail + " " + (i.fixLabel ?? "")).lowercased().replacingOccurrences(of: "figmamcp", with: "")
                    for b in banned { XCTAssertFalse(text.contains(b), "\(name): '\(text)' contains \(b)") }
                }
            }
        }
    }
}
