import Foundation

public protocol Engine: Sendable {
    func status() async -> Result<EngineReport, EngineFailure>
    func setup(restartFigma: Bool) async -> Result<EngineReport, EngineFailure>
    /// doctor's plain-text report, for "Copy diagnostics".
    func diagnostics() async -> String
}

public extension Engine {
    func diagnostics() async -> String { "" }
}

public struct EngineFailure: Error, Equatable, Sendable {
    public var message: String
    public init(_ m: String) { message = m }
}

/// Runs the bundled `figmamcp` command. Override the path with FIGMAMCP_CLI (used by tests and the stub).
public struct CLIEngine: Engine {
    public var executable: URL
    public var timeout: TimeInterval

    public init(executable: URL, timeout: TimeInterval = 90) {
        self.executable = executable; self.timeout = timeout
    }

    public static func bundled() -> CLIEngine {
        if let p = ProcessInfo.processInfo.environment["FIGMAMCP_CLI"], !p.isEmpty {
            return CLIEngine(executable: URL(fileURLWithPath: p))
        }
        let res = Bundle.main.resourceURL ?? URL(fileURLWithPath: ".")
        return CLIEngine(executable: res.appendingPathComponent("bin/figmamcp"))
    }

    public func status() async -> Result<EngineReport, EngineFailure> {
        await run(["status", "--json"])
    }

    public func setup(restartFigma: Bool) async -> Result<EngineReport, EngineFailure> {
        await run(["setup", "--json"] + (restartFigma ? ["--restart-figma"] : []))
    }

    public func diagnostics() async -> String {
        let exe = executable, limit = timeout
        return await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                cont.resume(returning: CLIEngine.runText(exe, ["doctor"], limit))
            }
        }
    }

    /// Runs the engine and returns its stdout and exit code as text. Never throws.
    static func runText(_ exe: URL, _ args: [String], _ limit: TimeInterval) -> String {
        guard FileManager.default.isExecutableFile(atPath: exe.path) else { return "engine missing: \(exe.lastPathComponent)" }
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out; p.standardError = out; p.standardInput = FileHandle.nullDevice
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", env["PATH"] ?? ""].joined(separator: ":")
        p.environment = env
        do { try p.run() } catch { return "engine did not start" }
        let deadline = Date().addingTimeInterval(limit)
        var data = Data()
        while p.isRunning && Date() < deadline { data.append(out.fileHandleForReading.availableData) }
        if p.isRunning { p.terminate(); return String(decoding: data, as: UTF8.self) + "\n(timed out)" }
        data.append(out.fileHandleForReading.readDataToEndOfFile())
        return String(decoding: data, as: UTF8.self) + "\nexit code \(p.terminationStatus)"
    }

    func run(_ args: [String]) async -> Result<EngineReport, EngineFailure> {
        let exe = executable, limit = timeout
        return await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                cont.resume(returning: CLIEngine.runSync(exe, args, limit))
            }
        }
    }

    static func runSync(_ exe: URL, _ args: [String], _ limit: TimeInterval) -> Result<EngineReport, EngineFailure> {
        guard FileManager.default.isExecutableFile(atPath: exe.path) else {
            return .failure(.init(L10n.t("FigmaMCP is missing a part it needs. Reinstall the app.", "FigmaMCP 缺少需要的组件。请重新安装应用。")))
        }
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        let out = Pipe(), err = Pipe()
        p.standardOutput = out; p.standardError = err
        p.standardInput = FileHandle.nullDevice
        var env = ProcessInfo.processInfo.environment
        // GUI apps start with a minimal PATH; the engine looks for claude/codex on a normal one.
        env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", env["PATH"] ?? ""].joined(separator: ":")
        p.environment = env
        var outData = Data()
        let group = DispatchGroup()
        group.enter()
        out.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; group.leave() } else { outData.append(d) }
        }
        do { try p.run() } catch {
            out.fileHandleForReading.readabilityHandler = nil
            return .failure(.init(L10n.t("FigmaMCP could not start its checker.", "FigmaMCP 无法启动检查程序。")))
        }
        let deadline = DispatchTime.now() + limit
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { p.waitUntilExit(); done.signal() }
        if done.wait(timeout: deadline) == .timedOut {
            p.terminate()
            return .failure(.init(L10n.t("That took too long. Try again.", "耗时太长。请再试一次。")))
        }
        _ = group.wait(timeout: .now() + 2)
        if let report = ReportParser.parse(outData) { return .success(report) }
        return .failure(.init(L10n.t("FigmaMCP got an answer it could not read.", "FigmaMCP 收到了无法读取的结果。")))
    }
}
