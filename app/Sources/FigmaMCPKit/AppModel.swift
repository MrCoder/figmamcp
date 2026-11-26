import Foundation
import AppKit
import SwiftUI

@MainActor
public final class AppModel: ObservableObject {
    @Published public private(set) var snapshot = Snapshot()
    @Published public private(set) var busy = false
    @Published public var notice: String?          // short result line shown in the popover
    @Published public var showAccessGuide = false  // picture guide when opening is not allowed
    @Published public var launchAtLogin = false
    @Published public var forceSetupView = false  // "Set up again"
    @Published public private(set) var availableUpdate: String?  // newer version, for example "0.1.12"

    public var stage: SetupStage { forceSetupView && snapshot.report != nil ? .addToFigma : Flow.stage(snapshot) }
    public var health: [HealthItem] { Flow.health(snapshot) }
    public var connection: [ConnState] { Flow.connection(snapshot) }
    @Published public var diagnosticsCopied = false
    public var status: MenuStatus { Flow.menuStatus(snapshot) }
    public var currentFile: String? { snapshot.report?.currentFile }
    public var aiSessions: Int { snapshot.report?.openFiles.reduce(0) { $0 + $1.aiSessions } ?? 0 }
    public var engineMessage: String? { snapshot.engineError }

    private let engine: Engine
    private let opener: PluginOpener
    private let login: LoginItem
    private let defaults: UserDefaults
    private var timer: Timer?
    private var tick = 0
    private var quietUpdateTried = false
    private let updates: UpdateChecker?
    private let launchPing: LaunchPing?
    private let appVersion: String
    private var updateTimer: Timer?
    public var onNeedSetupWindow: (() -> Void)?

    /// `updates` and `launchPing` are nil in tests and previews, so nothing touches the network there.
    public init(engine: Engine, opener: PluginOpener, login: LoginItem, defaults: UserDefaults = .standard,
                updates: UpdateChecker? = nil, launchPing: LaunchPing? = nil,
                appVersion: String = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0") {
        self.engine = engine; self.opener = opener; self.login = login; self.defaults = defaults
        self.updates = updates; self.launchPing = launchPing; self.appVersion = appVersion
        snapshot.accessSkipped = defaults.bool(forKey: "accessSkipped")
        snapshot.pluginSeen = defaults.bool(forKey: "pluginSeen")
        snapshot.openSkipped = defaults.bool(forKey: "openSkipped")
        snapshot.firstCallSeen = defaults.bool(forKey: "firstCallSeen")
        launchAtLogin = login.isEnabled
    }

    /// For rendering and tests: a model frozen on a given snapshot.
    public static func preview(_ s: Snapshot) -> AppModel {
        let m = AppModel(engine: NullEngine(), opener: PluginOpener(access: NullMenu()), login: NullLogin(),
                         defaults: UserDefaults(suiteName: "figmamcp.preview")!)
        m.snapshot = s
        return m
    }

    // MARK: lifecycle

    public func start() {
        Task { await refresh() }
        if let launchPing { Task { await launchPing.ping(version: appVersion, defaults: defaults) } }
        if updates != nil {
            Task { await checkForUpdate() }
            updateTimer = Timer.scheduledTimer(withTimeInterval: 24 * 60 * 60, repeats: true) { [weak self] _ in
                Task { @MainActor in await self?.checkForUpdate() }
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.onTick() }
        }
    }

    private func onTick() {
        tick += 1
        updateLocalFacts()
        let interval = (stage == .done) ? 15 : 3
        if tick % interval == 0, !busy { Task { await refresh() } }
    }

    private func updateLocalFacts() {
        let granted = AccessibilityGate.granted
        let running = !NSRunningApplication.runningApplications(withBundleIdentifier: SystemFigmaMenu.bundleID).isEmpty
        if snapshot.accessGranted != granted { snapshot.accessGranted = granted }
        if snapshot.figmaRunning != running { snapshot.figmaRunning = running }
    }

    public func refresh() async {
        updateLocalFacts()
        switch await engine.status() {
        case .success(let r): snapshot.report = r; snapshot.engineError = nil
        case .failure(let f): if snapshot.report == nil { snapshot.engineError = f.message }
        }
        if !quietUpdateTried, !busy, Flow.needsQuietUpdate(snapshot) {
            quietUpdateTried = true  // once per launch, so a failing update cannot loop
            await runSetup(quiet: true)
            return
        }
        if let f = snapshot.report?.figmaRunning { snapshot.figmaRunning = f || snapshot.figmaRunning }
        if let r = snapshot.report, !snapshot.firstCallSeen, r.openFiles.contains(where: { ($0.completedCalls ?? 0) > 0 }) {
            snapshot.firstCallSeen = true
            defaults.set(true, forKey: "firstCallSeen")
        }
        if let r = snapshot.report, Flow.pluginOpen(r), !snapshot.pluginSeen {
            snapshot.pluginSeen = true
            defaults.set(true, forKey: "pluginSeen")
            markDoneIfFinished()
        }
    }

    /// Asks GitHub for the latest release. A network error leaves everything as it was.
    public func checkForUpdate() async {
        guard let updates else { return }
        if let newer = await updates.newerVersion(than: appVersion) { availableUpdate = newer }
    }

    public func openUpdatePage() { NSWorkspace.shared.open(UpdateChecker.downloadPage) }

    private func markDoneIfFinished() {
        if Flow.stage(snapshot) == .done { try? login.setEnabled(true); launchAtLogin = login.isEnabled }
    }

    public func skipOpen() {
        snapshot.openSkipped = true
        defaults.set(true, forKey: "openSkipped")
        markDoneIfFinished()
    }

    /// Launches Figma (no permission needed). Opening FigmaMCP inside it needs the menu permission.
    public func launchFigma() {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: SystemFigmaMenu.bundleID) {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    // MARK: actions

    /// `quiet` is the update after an app update: it never restarts Figma.
    public func runSetup(quiet: Bool = false) async {
        busy = true; defer { busy = false }
        let restart = !quiet && Flow.needsFigmaRestart(snapshot)
        switch await engine.setup(restartFigma: restart) {
        case .success(let r):
            snapshot.report = r; snapshot.engineError = nil; forceSetupView = false
            notice = nil
            if Flow.stage(snapshot) == .done { try? login.setEnabled(true); launchAtLogin = login.isEnabled }
        case .failure(let f):
            notice = f.message
        }
        await refresh()
    }

    public func perform(_ fix: Fix) {
        switch fix {
        case .installFigma: NSWorkspace.shared.open(URL(string: "https://www.figma.com/downloads/")!)
        case .openAIHelp: NSWorkspace.shared.open(URL(string: "https://claude.com/product/claude-code")!)
        case .setUp: Task { await runSetup() }
        case .allowOpening: requestAccess(); onNeedSetupWindow?()
        case .openFigma: Task { _ = await openInFigma() }
        case .launchFigma: launchFigma()
        }
    }

    public func requestAccess() { AccessibilityGate.requestAndOpenSettings() }

    public func skipAccess() {
        snapshot.accessSkipped = true
        defaults.set(true, forKey: "accessSkipped")
        if Flow.stage(snapshot) == .done { try? login.setEnabled(true); launchAtLogin = login.isEnabled }
    }

    public func finishedAccessGranted() {
        if Flow.stage(snapshot) == .done { try? login.setEnabled(true); launchAtLogin = login.isEnabled }
    }

    public func setLaunchAtLogin(_ on: Bool) {
        try? login.setEnabled(on); launchAtLogin = login.isEnabled
    }

    @discardableResult
    public func openInFigma() async -> OpenOutcome {
        busy = true; defer { busy = false }
        let outcome = await opener.open()
        notice = outcome == .opened ? nil : outcome.message
        showAccessGuide = outcome == .accessDenied
        return outcome
    }

    /// Called by the local socket when the AI asks for FigmaMCP to be opened.
    public func handleCommand(_ cmd: String) async -> [String: Any] {
        guard cmd == "open-plugin" else {
            return ["ok": false, "outcome": "unknown-command", "message": "Unknown command."]
        }
        return await openInFigma().json
    }

    /// Puts doctor's report, with personal details taken out, on the clipboard.
    public func copyDiagnostics() async {
        let doctor = await engine.diagnostics()
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let text = Diagnostics.build(doctorText: doctor, report: snapshot.report, appVersion: version)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        diagnosticsCopied = true
    }

    public func setUpAgain() {
        forceSetupView = true
        onNeedSetupWindow?()
    }
}

// MARK: inert collaborators for previews

struct NullEngine: Engine {
    func status() async -> Result<EngineReport, EngineFailure> { .failure(.init("preview")) }
    func setup(restartFigma: Bool) async -> Result<EngineReport, EngineFailure> { .failure(.init("preview")) }
}
final class NullMenu: FigmaMenuAccess {
    var isTrusted = false; var figmaInstalled = true
    func activateFigma() {}
    func hasMenuBarItem(_ title: String) -> Bool { false }
    func press(path: [String]) -> Bool { false }
}
final class NullLogin: LoginItem {
    var isEnabled = false
    func setEnabled(_ on: Bool) throws { isEnabled = on }
}
