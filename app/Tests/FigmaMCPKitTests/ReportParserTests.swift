import XCTest
@testable import FigmaMCPKit

final class ReportParserTests: XCTestCase {
    func testParsesObjectWithSteps() {
        let r = Fixture.report("fresh")
        XCTAssertEqual(r.steps.count, 8)
        XCTAssertEqual(r.step("agent-claude")?.state, .todo)
        XCTAssertEqual(r.step("agent-codex")?.state, .skip)
        XCTAssertEqual(r.step("plugin")?.state, .todo)
    }

    func testToleratesLogNoiseAroundJSON() {
        let data = Data("starting...\n{\"steps\":[{\"id\":\"figma\",\"state\":\"ok\"}]}\ndone\n".utf8)
        XCTAssertEqual(ReportParser.parse(data)?.step("figma")?.state, .ok)
    }

    func testBareArrayAndAlternateKeys() {
        let data = Data(#"[{"step":"figma","status":"PASS","detail":"hi","fix":{"label":"Do it"}},{"name":"relay","result":"error"}]"#.utf8)
        let r = ReportParser.parse(data)!
        XCTAssertEqual(r.step("figma")?.state, .ok)
        XCTAssertEqual(r.step("figma")?.message, "hi")
        XCTAssertEqual(r.step("figma")?.fix, "Do it")
        XCTAssertEqual(r.step("relay")?.state, .fail)
    }

    func testUnknownStateIsNeverOk() {
        let data = Data(#"{"steps":[{"id":"figma","state":"banana"},{"id":"x"}]}"#.utf8)
        let r = ReportParser.parse(data)!
        XCTAssertEqual(r.step("figma")?.state, .todo)
        XCTAssertEqual(r.step("x")?.state, .todo)
    }

    func testSkipsMalformedStepsAndRejectsGarbage() {
        XCTAssertEqual(ReportParser.parse(Data(#"{"steps":[1,{"nope":true},{"id":"a","state":"ok"}]}"#.utf8))?.steps.count, 1)
        XCTAssertNil(ReportParser.parse(Data("not json at all".utf8)))
        XCTAssertNil(ReportParser.parse(Data()))
    }

    func testCurrentFileAndRunning() {
        let r = Fixture.report("ready")
        XCTAssertEqual(r.currentFile, "Checkout flow")
        XCTAssertEqual(r.figmaRunning, true)
    }

    func testOpenFilesFromTheEngine() {
        let r = ReportParser.parse(Data(#"{"steps":[],"currentFile":"A","openFiles":[{"fileName":"A","aiSessions":2},{"fileName":null,"aiSessions":0},{"fileName":""}]}"#.utf8))!
        XCTAssertEqual(r.openFiles, [OpenFile(name: "A", aiSessions: 2), OpenFile(name: nil, aiSessions: 0), OpenFile(name: nil, aiSessions: 0)])
        XCTAssertTrue(Flow.pluginOpen(r))
        XCTAssertTrue(Flow.pluginOpen(ReportParser.parse(Data(#"{"steps":[],"openFiles":[{"fileName":null,"aiSessions":0}]}"#.utf8))!))
    }

    func testPlainEnglishHidesJargon() {
        XCTAssertNil(PlainEnglish.safe("Port 3055 is already used by another program"))
        XCTAssertNil(PlainEnglish.safe("MCP server missing"))
        XCTAssertNil(PlainEnglish.safe("Import the plugin"))
        XCTAssertEqual(PlainEnglish.safe("Something stopped."), "Something stopped.")
    }

    func testParsesOutdatedPanels() {
        let r = ReportParser.parse(Data(#"{"steps":[],"openFiles":[{"fileName":"A","aiSessions":0,"outdated":true},{"fileName":"B"}]}"#.utf8))!
        XCTAssertEqual(r.openFiles.map(\.outdated), [true, false])
        XCTAssertFalse(Flow.pluginOpen(ReportParser.parse(Data(#"{"steps":[],"openFiles":[{"fileName":"A","outdated":true}]}"#.utf8))!))
    }
}
