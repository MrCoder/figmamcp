import XCTest
@testable import FigmaMCPKit

/// Collects what a fake network was asked for.
final class Requests: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [URL] = []
    func add(_ u: URL) { lock.lock(); items.append(u); lock.unlock() }
    var urls: [URL] { lock.lock(); defer { lock.unlock() }; return items }
}

final class TrackedRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [URLRequest] = []
    func add(_ r: URLRequest) { lock.lock(); items.append(r); lock.unlock() }
    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return items }
}

final class VersionCompareTests: XCTestCase {
    func testNumbersCompareAsNumbersNotText() {
        XCTAssertTrue(VersionCompare.isNewer("0.1.10", than: "0.1.9"))
        XCTAssertTrue(VersionCompare.isNewer("0.1.19", than: "0.1.10"))
        XCTAssertFalse(VersionCompare.isNewer("0.1.9", than: "0.1.10"))
        XCTAssertFalse(VersionCompare.isNewer("0.1.10", than: "0.1.19"))
    }

    func testEqualAndOlderAreNotUpdates() {
        XCTAssertFalse(VersionCompare.isNewer("0.1.12", than: "0.1.12"))
        XCTAssertFalse(VersionCompare.isNewer("v0.1.12", than: "0.1.12"))
        XCTAssertFalse(VersionCompare.isNewer("0.1.11", than: "0.1.12"))
    }

    func testLeadingVAndMajorMinorBoundaries() {
        XCTAssertTrue(VersionCompare.isNewer("v0.2.0", than: "0.1.99"))
        XCTAssertTrue(VersionCompare.isNewer("1.0.0", than: "0.99.99"))
        XCTAssertTrue(VersionCompare.isNewer("0.1.12", than: "0.1"))
    }

    func testUnreadableVersionsNeverCountAsUpdates() {
        XCTAssertFalse(VersionCompare.isNewer("", than: "0.1.0"))
        XCTAssertFalse(VersionCompare.isNewer("nightly", than: "0.1.0"))
        XCTAssertFalse(VersionCompare.isNewer("0.2.0-beta", than: "0.1.0"))
        XCTAssertFalse(VersionCompare.isNewer("0.2.0", than: "unknown"))
    }
}

final class UpdateCheckerTests: XCTestCase {
    private func checker(tag: String?, seen: Requests = Requests()) -> UpdateChecker {
        UpdateChecker { url in
            seen.add(url)
            guard let tag else { throw URLError(.notConnectedToInternet) }
            return Data(#"{"tag_name": "\#(tag)", "name": "x"}"#.utf8)
        }
    }

    func testAsksGitHubForTheLatestRelease() async {
        let seen = Requests()
        _ = await checker(tag: "v0.1.12", seen: seen).newerVersion(than: "0.1.11")
        XCTAssertEqual(seen.urls.map(\.absoluteString), ["https://api.github.com/repos/MrCoder/figmamcp-releases/releases/latest"])
    }

    func testNewerTagIsReportedWithoutTheLeadingV() async {
        let v = await checker(tag: "v0.1.12").newerVersion(than: "0.1.11")
        XCTAssertEqual(v, "0.1.12")
    }

    func testSameOrOlderTagReportsNothing() async {
        let same = await checker(tag: "v0.1.11").newerVersion(than: "0.1.11")
        XCTAssertNil(same)
        let older = await checker(tag: "v0.1.9").newerVersion(than: "0.1.10")
        XCTAssertNil(older)
    }

    func testNetworkErrorAndBadJSONFailSilently() async {
        let offline = await checker(tag: nil).newerVersion(than: "0.1.0")
        XCTAssertNil(offline)
        let junk = UpdateChecker { _ in Data("not json".utf8) }
        let none = await junk.newerVersion(than: "0.1.0")
        XCTAssertNil(none)
    }

    func testDownloadPageIsTheSiteNotGitHub() {
        XCTAssertEqual(UpdateChecker.downloadPage.absoluteString, "https://figmamcp.dev/download")
    }

    @MainActor func testModelShowsTheUpdateAndKeepsItWhenALaterCheckFails() async {
        let suite = "figmamcp.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let m = AppModel(engine: NullEngine(), opener: PluginOpener(access: NullMenu()), login: NullLogin(), defaults: defaults,
                         updates: checker(tag: "v0.1.12"), appVersion: "0.1.11")
        XCTAssertNil(m.availableUpdate)
        await m.checkForUpdate()
        XCTAssertEqual(m.availableUpdate, "0.1.12")

        let upToDate = AppModel(engine: NullEngine(), opener: PluginOpener(access: NullMenu()), login: NullLogin(), defaults: defaults,
                                updates: checker(tag: "v0.1.11"), appVersion: "0.1.11")
        await upToDate.checkForUpdate()
        XCTAssertNil(upToDate.availableUpdate)
    }
}

final class LaunchPingTests: XCTestCase {
    private func freshDefaults() -> (UserDefaults, () -> Void) {
        let suite = "figmamcp.test.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!
        return (d, { d.removePersistentDomain(forName: suite) })
    }

    func testAppIDIsSixteenHexCharactersAndStaysTheSame() {
        let (d, cleanup) = freshDefaults(); defer { cleanup() }
        let id = LaunchPing.appID(defaults: d)
        XCTAssertEqual(id.count, 16)
        XCTAssertNotNil(id.range(of: "^[0-9a-f]{16}$", options: .regularExpression))
        XCTAssertEqual(LaunchPing.appID(defaults: d), id)
    }

    func testAStoredValueThatIsNotAnIDIsReplaced() {
        let (d, cleanup) = freshDefaults(); defer { cleanup() }
        d.set("someone@example.com", forKey: LaunchPing.defaultsKey)
        let id = LaunchPing.appID(defaults: d)
        XCTAssertNotNil(id.range(of: "^[0-9a-f]{16}$", options: .regularExpression))
    }

    func testPingAsksForPGifWithAppVersionAndIDOnly() async {
        let (d, cleanup) = freshDefaults(); defer { cleanup() }
        let seen = Requests()
        await LaunchPing { seen.add($0) }.ping(version: "0.1.11", defaults: d)
        XCTAssertEqual(seen.urls.count, 1)
        let id = LaunchPing.appID(defaults: d)
        XCTAssertEqual(seen.urls[0].absoluteString, "https://figmamcp.dev/p.gif?v=app-0.1.11&i=\(id)")
        // The site accepts v up to 32 characters.
        XCTAssertLessThanOrEqual("app-0.1.11".count, 32)
    }

    func testAppLaunchedEventHasFixedFieldsOnly() throws {
        let request = LaunchPing.trackRequest(version: "0.1.24", id: "0123456789abcdef",
                                              now: Date(timeIntervalSince1970: 1_800_000_000), osMajor: 26, insertID: "abcd1234-0000")
        XCTAssertEqual(request.url, LaunchPing.trackURL)
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [[String: Any]])
        XCTAssertEqual(body.count, 1)
        XCTAssertEqual(body[0]["event"] as? String, "app_launched")
        let props = try XCTUnwrap(body[0]["properties"] as? [String: Any])
        XCTAssertEqual(Set(props.keys), ["distinct_id", "time", "$insert_id", "product", "os", "app_version"])
        XCTAssertEqual(props["distinct_id"] as? String, "0123456789abcdef")
        XCTAssertEqual(props["time"] as? Int, 1_800_000_000_000)
        XCTAssertEqual(props["os"] as? String, "macOS 26")
        XCTAssertEqual(props["app_version"] as? String, "0.1.24")
        XCTAssertEqual(props["product"] as? String, "figmamcp")
    }

    func testPingAlsoSendsAppLaunchedWithTheSameID() async {
        let (d, cleanup) = freshDefaults(); defer { cleanup() }
        let seen = Requests()
        let tracked = TrackedRequests()
        await LaunchPing(send: { seen.add($0) }, track: { tracked.add($0) }, telemetryOn: { true }).ping(version: "0.1.24", defaults: d)
        XCTAssertEqual(seen.urls.count, 1)
        XCTAssertEqual(tracked.requests.count, 1)
        let id = LaunchPing.appID(defaults: d)
        let body = String(data: tracked.requests[0].httpBody ?? Data(), encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("\"distinct_id\":\"\(id)\""))
    }

    func testTelemetryOffSendsNoAppLaunched() async {
        let (d, cleanup) = freshDefaults(); defer { cleanup() }
        let tracked = TrackedRequests()
        await LaunchPing(send: { _ in }, track: { tracked.add($0) }, telemetryOn: { false }).ping(version: "0.1.24", defaults: d)
        XCTAssertEqual(tracked.requests.count, 0)
    }

    func testTelemetrySwitches() throws {
        let home = NSTemporaryDirectory() + "figmamcp-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: home) }
        XCTAssertTrue(LaunchPing.telemetryEnabled(environment: [:], home: home))
        XCTAssertFalse(LaunchPing.telemetryEnabled(environment: ["FIGMAMCP_TELEMETRY": "0"], home: home))
        try FileManager.default.createDirectory(atPath: home + "/.figmamcp", withIntermediateDirectories: true)
        try Data(#"{"port":3155,"telemetry":false}"#.utf8).write(to: URL(fileURLWithPath: home + "/.figmamcp/config.json"))
        XCTAssertFalse(LaunchPing.telemetryEnabled(environment: [:], home: home))
    }

    @MainActor func testModelPingsOnceOnStart() async throws {
        let (d, cleanup) = freshDefaults(); defer { cleanup() }
        let seen = Requests()
        let m = AppModel(engine: NullEngine(), opener: PluginOpener(access: NullMenu()), login: NullLogin(), defaults: d,
                         launchPing: LaunchPing { seen.add($0) }, appVersion: "0.1.11")
        m.start()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(seen.urls.count, 1)
        XCTAssertTrue(seen.urls[0].absoluteString.hasPrefix("https://figmamcp.dev/p.gif?v=app-0.1.11&i="))
    }
}
