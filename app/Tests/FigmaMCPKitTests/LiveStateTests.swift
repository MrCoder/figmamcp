import XCTest
@testable import FigmaMCPKit

final class LiveStateTests: XCTestCase {
    override func tearDown() { L10n.lang = .en }

    func testParsesLoadedCountsAndFinishedRequests() {
        let r = Fixture.report("working")
        XCTAssertEqual(r.loaded["agent-claude"], 1)
        XCTAssertEqual(r.openFiles.first?.completedCalls, 3)
        // An older engine sends no `loaded`: unknown, never zero.
        XCTAssertNil(Fixture.report("ready").loaded["agent-claude"])
    }

    func testSetUpIsNotConnected() {
        // Config written but the running client never loaded it: shown as set up, with the restart hint next to it.
        let s = Fixture.snapshot("notloaded", access: true, seen: true)
        let states = Flow.connection(s)
        XCTAssertEqual(states.map(\.kind), [.config, .loaded, .pluginOnline, .firstCall])
        XCTAssertEqual(states[0].tick, .good)
        // Codex loaded it, so the row is fine; Claude Code is named in a neutral caption.
        XCTAssertEqual(states[1].tick, .good)
        XCTAssertTrue(states[1].detail.contains("To use Claude Code too, open or restart it"), states[1].detail)
        XCTAssertFalse(states[1].detail.contains("restart Codex"), states[1].detail)
        XCTAssertEqual(states[2].tick, .needsFix)
        XCTAssertEqual(states[3].tick, .waiting)
        let ai = Flow.health(s).first { $0.kind == .ai }!
        XCTAssertFalse(ai.detail.lowercased().contains("connected"), ai.detail)
    }

    func testNoClientLoadedNeedsFix() {
        var r = Fixture.report("notloaded"); r.loaded = ["agent-claude": 0, "agent-codex": 0]
        let st = Flow.connection(Snapshot(report: r, accessGranted: true, figmaRunning: true, pluginSeen: true))[1]
        XCTAssertEqual(st.tick, .needsFix)
        XCTAssertTrue(st.detail.contains("Claude Code and Codex"), st.detail)
    }

    func testPopoverSubtitleNamesTheFirstOpenProblem() {
        XCTAssertEqual(Flow.firstConnectionProblem(Fixture.snapshot("notloaded", access: true, seen: true))?.kind, .pluginOnline)
        XCTAssertNil(Flow.firstConnectionProblem(Fixture.snapshot("working", access: true, seen: true)))
    }

    func testAllFourStatesGoodOnceARequestFinished() {
        let s = Fixture.snapshot("working", access: true, seen: true)
        XCTAssertEqual(Flow.connection(s).map(\.tick), [.good, .good, .good, .good])
    }

    func testFirstCallIsRememberedAfterTheRelayRestarts() {
        var s = Fixture.snapshot("notloaded", access: true, seen: true)
        s.firstCallSeen = true
        XCTAssertEqual(Flow.connection(s)[3].tick, .good)
    }

    func testOlderEngineShowsUnknownNotFailure() {
        let s = Fixture.snapshot("ready", access: true, seen: true)
        XCTAssertEqual(Flow.connection(s)[1].tick, .unknown)
    }

    func testDiagnosticsAreRedacted() {
        let raw = """
        ok  FigmaMCP files  Version 1 is installed in /Users/alice/.figmamcp.
        FigmaMCP is open in 1 Figma file: "Secret roadmap".
        host alice-mbp.local user alice
        """
        let out = Diagnostics.redact(raw, home: "/Users/alice", user: "alice", host: "alice-mbp.local", fileNames: ["Secret roadmap"])
        XCTAssertFalse(out.contains("alice"), out)
        XCTAssertFalse(out.contains("Secret roadmap"), out)
        XCTAssertTrue(out.contains("~/.figmamcp"), out)
        XCTAssertTrue(out.contains("\"file 1\""), out)
        // Short names and unquoted words are left alone.
        let keep = Diagnostics.redact("FigmaMCP app 1 running", home: "/Users/app", user: "app", host: "a", fileNames: ["1"])
        XCTAssertEqual(keep, "FigmaMCP <user> 1 running")
        let k2 = Diagnostics.redact("FigmaMCP app ok", home: "/Users/ai", user: "ai", host: "x", fileNames: ["UI"])
        XCTAssertEqual(k2, "FigmaMCP app ok")
    }

    func testChineseCopy() {
        L10n.lang = .zh
        let s = Fixture.snapshot("notloaded", access: true, seen: true)
        XCTAssertTrue(Flow.connection(s)[1].detail.contains("Claude Code"), Flow.connection(s)[1].detail)
        XCTAssertEqual(MenuStatus.ready.label, "就绪")
        XCTAssertEqual(L10n.Lang.from(["zh-Hant-TW"]), .zh)
        XCTAssertEqual(L10n.Lang.from(["zh-Hans-CN", "en"]), .zh)
        XCTAssertEqual(L10n.Lang.from(["en-US", "zh-Hans"]), .en)
    }
}
