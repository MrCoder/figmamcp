import XCTest
@testable import FigmaMCPKit

/// Engine whose status is fixed until setup runs; then it reports `after`. Records each setup call.
final class UpdatingEngine: Engine, @unchecked Sendable {
    var current: EngineReport
    let after: EngineReport
    var setupCalls: [Bool] = []
    init(_ before: EngineReport, after: EngineReport) { current = before; self.after = after }
    func status() async -> Result<EngineReport, EngineFailure> { .success(current) }
    func setup(restartFigma: Bool) async -> Result<EngineReport, EngineFailure> {
        setupCalls.append(restartFigma); current = after; return .success(after)
    }
}

/// Engine that answers status with a queue of fixture reports.
final class QueueEngine: Engine, @unchecked Sendable {
    var reports: [EngineReport]
    init(_ r: [EngineReport]) { reports = r }
    func status() async -> Result<EngineReport, EngineFailure> { .success(reports.count > 1 ? reports.removeFirst() : reports[0]) }
    func setup(restartFigma: Bool) async -> Result<EngineReport, EngineFailure> { await status() }
}

@MainActor
final class ModelTests: XCTestCase {
    func testSeeingFigmaMCPOpenIsRememberedAfterTheFileCloses() async {
        let suite = "figmamcp.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let engine = QueueEngine([Fixture.report("ready"), Fixture.report("fresh")])
        let m = AppModel(engine: engine, opener: PluginOpener(access: NullMenu()), login: NullLogin(), defaults: defaults)
        XCTAssertFalse(m.snapshot.pluginSeen)
        await m.refresh()                       // FigmaMCP open in "Checkout flow"
        XCTAssertTrue(m.snapshot.pluginSeen)
        await m.refresh()                       // file closed
        XCTAssertTrue(m.snapshot.pluginSeen)
        // A new launch reads the flag back, so the setup window does not reopen.
        let again = AppModel(engine: QueueEngine([Fixture.report("fresh")]), opener: PluginOpener(access: NullMenu()),
                             login: NullLogin(), defaults: defaults)
        XCTAssertTrue(again.snapshot.pluginSeen)
        defaults.removePersistentDomain(forName: suite)
    }

    func testSkippingTheOpenStepIsRemembered() {
        let suite = "figmamcp.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let m = AppModel(engine: QueueEngine([Fixture.report("ready")]), opener: PluginOpener(access: NullMenu()), login: NullLogin(), defaults: defaults)
        m.skipOpen()
        XCTAssertTrue(m.snapshot.openSkipped)
        let again = AppModel(engine: QueueEngine([Fixture.report("ready")]), opener: PluginOpener(access: NullMenu()), login: NullLogin(), defaults: defaults)
        XCTAssertTrue(again.snapshot.openSkipped)
        defaults.removePersistentDomain(forName: suite)
    }

    func testAnOutdatedPanelIsNotRememberedAsSeen() async {
        let suite = "figmamcp.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let m = AppModel(engine: QueueEngine([Fixture.report("outdated")]), opener: PluginOpener(access: NullMenu()), login: NullLogin(), defaults: defaults)
        await m.refresh()
        XCTAssertFalse(m.snapshot.pluginSeen)
        defaults.removePersistentDomain(forName: suite)
    }

    // Owner, 2026-11-11: an update must not leave the user anything to reopen or click. After the app is
    // updated, the engine it carries is newer than the installed one; the app installs it by itself.
    func testAnUpdatedAppInstallsItsEngineWithoutAsking() async {
        let suite = "figmamcp.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let engine = UpdatingEngine(Fixture.report("appupdated"), after: Fixture.report("ready"))
        let m = AppModel(engine: engine, opener: PluginOpener(access: NullMenu()), login: NullLogin(), defaults: defaults)
        await m.refresh()
        XCTAssertEqual(engine.setupCalls, [false], "one quiet setup, never a Figma restart")
        XCTAssertEqual(m.snapshot.report?.step("runtime")?.state, .ok)
        await m.refresh()
        XCTAssertEqual(engine.setupCalls, [false], "runs once, not on every refresh")
        defaults.removePersistentDomain(forName: suite)
    }

    // A first-time user has not agreed to anything yet: their setup still waits for the button.
    func testAFreshInstallStillWaitsForTheButton() async {
        let suite = "figmamcp.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let engine = UpdatingEngine(Fixture.report("fresh"), after: Fixture.report("ready"))
        let m = AppModel(engine: engine, opener: PluginOpener(access: NullMenu()), login: NullLogin(), defaults: defaults)
        await m.refresh()
        XCTAssertEqual(engine.setupCalls, [])
        defaults.removePersistentDomain(forName: suite)
    }
}
