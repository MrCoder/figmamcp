import XCTest
import Darwin
@testable import FigmaMCPKit

final class SocketAndEngineTests: XCTestCase {
    func roundTrip(path: String, _ line: String) -> [String: Any]? {
        let s = socket(AF_UNIX, SOCK_STREAM, 0); defer { close(s) }
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        withUnsafeMutableBytes(of: &addr.sun_path) { r in bytes.withUnsafeBytes { r.copyMemory(from: $0) } }
        let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard rc == 0 else { return nil }
        let msg = Array((line + "\n").utf8)
        _ = send(s, msg, msg.count, 0)
        var out = Data(); var buf = [UInt8](repeating: 0, count: 512)
        while true { let n = recv(s, &buf, buf.count, 0); if n <= 0 { break }; out.append(buf, count: n) }
        return try? JSONSerialization.jsonObject(with: out) as? [String: Any]
    }

    func testSocketRepliesWithOutcomeAndRejectsGarbage() throws {
        let path = "/tmp/fmcp-\(getpid()).sock"
        let sock = CommandSocket(path: path) { cmd in
            cmd == "open-plugin" ? OpenOutcome.noFileOpen.json : ["ok": false, "outcome": "unknown-command"]
        }
        try sock.start(); defer { sock.stop() }
        let attrs = try FileManager.default.attributesOfItem(atPath: path)
        XCTAssertEqual((attrs[.posixPermissions] as? Int) ?? 0, 0o600)
        let a = roundTrip(path: path, #"{"cmd":"open-plugin"}"#)
        XCTAssertEqual(a?["outcome"] as? String, "no-file-open")
        let b = roundTrip(path: path, "garbage")
        XCTAssertEqual(b?["outcome"] as? String, "bad-request")
        let c = roundTrip(path: path, #"{"cmd":"nope"}"#)
        XCTAssertEqual(c?["outcome"] as? String, "unknown-command")
    }

    func testEngineRunsStubAndParsesNoisyOutput() async throws {
        let engine = CLIEngine(executable: Fixture.stubDir.appendingPathComponent("figmamcp"))
        let r = try await engine.status().get()
        XCTAssertEqual(r.step("plugin")?.state, .ok)
    }

    func testEngineSetupPassesRestartFlag() async throws {
        let log = NSTemporaryDirectory() + "stub-\(getpid()).log"
        let state = NSTemporaryDirectory() + "state-\(getpid()).json"
        try Fixture.scenario("fresh").write(to: URL(fileURLWithPath: state))
        setenv("FIGMAMCP_STUB_LOG", log, 1); setenv("FIGMAMCP_STUB_STATE", state, 1)
        defer { unsetenv("FIGMAMCP_STUB_LOG"); unsetenv("FIGMAMCP_STUB_STATE") }
        let engine = CLIEngine(executable: Fixture.stubDir.appendingPathComponent("figmamcp"))
        let before = try await engine.status().get()
        XCTAssertEqual(before.step("plugin")?.state, .todo)
        _ = try await engine.setup(restartFigma: true).get()
        XCTAssertEqual(try String(contentsOfFile: log, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), "setup --json --restart-figma")
        let after = try await engine.status().get()
        XCTAssertEqual(after.step("plugin")?.state, .ok)
    }

    func testMissingEngineGivesPlainMessage() async {
        let r = await CLIEngine(executable: URL(fileURLWithPath: "/nonexistent/figmamcp")).status()
        guard case .failure(let f) = r else { return XCTFail() }
        XCTAssertFalse(f.message.isEmpty)
    }
}
