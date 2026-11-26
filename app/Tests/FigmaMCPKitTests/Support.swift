import Foundation
@testable import FigmaMCPKit

enum Fixture {
    static var stubDir: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("stub")
    }
    static func scenario(_ name: String) -> Data {
        try! Data(contentsOf: stubDir.appendingPathComponent("scenarios/\(name).json"))
    }
    static func report(_ name: String) -> EngineReport { ReportParser.parse(scenario(name))! }
    static func snapshot(_ name: String, access: Bool = false, skipped: Bool = false, running: Bool = true,
                         seen: Bool = false, openSkipped: Bool = false) -> Snapshot {
        Snapshot(report: report(name), accessGranted: access, accessSkipped: skipped, figmaRunning: running,
                 pluginSeen: seen, openSkipped: openSkipped)
    }
}
