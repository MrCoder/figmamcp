import Foundation

/// Everything the flow logic needs. Pure data so the logic is unit-testable.
public struct Snapshot: Equatable, Sendable {
    public var report: EngineReport?
    public var engineError: String?
    public var accessGranted: Bool
    public var accessSkipped: Bool
    public var figmaRunning: Bool
    /// FigmaMCP has been seen open in a Figma file at least once. Remembered across launches.
    public var pluginSeen: Bool
    public var openSkipped: Bool
    /// An AI request has finished in a Figma file at least once. Remembered, because the helper's count resets on restart.
    public var firstCallSeen: Bool
    public init(report: EngineReport? = nil, engineError: String? = nil, accessGranted: Bool = false,
                accessSkipped: Bool = false, figmaRunning: Bool = false, pluginSeen: Bool = false, openSkipped: Bool = false,
                firstCallSeen: Bool = false) {
        self.report = report; self.engineError = engineError; self.accessGranted = accessGranted
        self.accessSkipped = accessSkipped; self.figmaRunning = figmaRunning
        self.pluginSeen = pluginSeen; self.openSkipped = openSkipped; self.firstCallSeen = firstCallSeen
    }
}

public enum SetupStage: Equatable, Sendable {
    case checking
    case engineProblem
    case installFigma
    case connectAI
    case addToFigma
    case allowOpening
    case openInFigma
    case done
}

public enum ItemKind: String, CaseIterable, Sendable {
    case figma, ai, addon, access, open
}

public enum Fix: Equatable, Sendable {
    case installFigma
    case openAIHelp
    case setUp          // run setup (restarts Figma if open)
    case allowOpening
    case openFigma
    case launchFigma    // start Figma itself (first open creates its settings)
}

public enum Health: Equatable, Sendable { case good, needsFix, optional }

public struct HealthItem: Equatable, Sendable, Identifiable {
    public var id: ItemKind { kind }
    public var kind: ItemKind
    public var health: Health
    public var title: String
    public var detail: String
    public var fix: Fix?
    public var fixLabel: String?
}

/// The four separate facts behind "it works": each is shown on its own, so a written setting is never shown as a live link.
public enum ConnKind: String, CaseIterable, Sendable { case config, loaded, pluginOnline, firstCall }
public enum ConnTick: Equatable, Sendable { case good, needsFix, waiting, unknown }
public struct ConnState: Equatable, Sendable, Identifiable {
    public var id: ConnKind { kind }
    public var kind: ConnKind
    public var tick: ConnTick
    public var title: String
    public var detail: String
}

public enum MenuStatus: Equatable, Sendable {
    case ready, needsAttention, figmaClosed
    public var label: String {
        switch self {
        case .ready: return L10n.t("Ready", "就绪")
        case .needsAttention: return L10n.t("Needs attention", "需要处理")
        case .figmaClosed: return L10n.t("Figma is closed", "Figma 未打开")
        }
    }
    public var symbol: String {
        switch self {
        case .ready: return "checkmark.circle.fill"
        case .needsAttention: return "exclamationmark.triangle.fill"
        case .figmaClosed: return "moon.zzz.fill"
        }
    }
    /// Menu bar glyph: one shape, state shown by variant.
    public var barSymbol: String {
        switch self {
        case .ready: return "wand.and.stars"
        case .needsAttention: return "exclamationmark.triangle"
        case .figmaClosed: return "moon.zzz"
        }
    }
}

public enum Flow {
    // MARK: derived facts

    public static func figmaInstalled(_ r: EngineReport) -> Bool {
        guard let s = r.step("figma") else { return true }
        return s.state != .fail && s.state != .todo
    }

    /// An AI app is present when any agent step is not "not found".
    public static func aiDetected(_ r: EngineReport) -> Bool {
        r.steps(prefix: "agent-").contains { $0.id != "agent-manual" && $0.state != .skip }
    }

    public static func aiNames(_ r: EngineReport) -> [String] {
        r.steps(prefix: "agent-").compactMap { $0.state == .skip ? nil : aiName($0.id) }
    }

    static func aiName(_ id: String) -> String? {
        switch id {
        case "agent-claude": return "Claude Code"
        case "agent-codex": return "Codex"
        default: return nil
        }
    }

    public static func aiConnected(_ r: EngineReport) -> Bool {
        let present = r.steps(prefix: "agent-").filter { $0.id != "agent-manual" && $0.state != .skip }
        return !present.isEmpty && present.allSatisfy { $0.state == .ok }
    }

    /// Setup can move on once at least one AI app is connected; a broken one is shown, not blocking.
    public static func anyAIConnected(_ r: EngineReport) -> Bool {
        r.steps(prefix: "agent-").contains { $0.id != "agent-manual" && $0.state == .ok }
    }

    public static func connectedAINames(_ r: EngineReport) -> [String] {
        r.steps(prefix: "agent-").compactMap { $0.state == .ok ? aiName($0.id) : nil }
    }

    /// FigmaMCP is open and usable in at least one Figma file right now. A panel from an older version does not count:
    /// the server refuses it until it is reopened.
    public static func pluginOpen(_ r: EngineReport) -> Bool {
        r.currentFile != nil || r.openFiles.contains { !$0.outdated }
    }

    /// Names of files whose FigmaMCP panel is from an older version (nil for an unnamed file).
    public static func outdatedFiles(_ r: EngineReport) -> [String?] {
        r.openFiles.filter(\.outdated).map(\.name)
    }

    public static func outdatedNotice(_ r: EngineReport) -> String? {
        let files = outdatedFiles(r)
        guard !files.isEmpty else { return nil }
        let names = files.compactMap { $0 }
        let place = names.isEmpty ? L10n.t("a Figma file", "一个 Figma 文件") : L10n.and(names.map(L10n.quote))
        return L10n.t("FigmaMCP in \(place) is from an older version. Close it and open it again.",
                      "\(place) 中的 FigmaMCP 是旧版本。请关闭后重新打开。")
    }

    // MARK: connection states

    /// First connection row that needs the user, for the popover's subtitle.
    public static func firstConnectionProblem(_ s: Snapshot) -> ConnState? {
        connection(s).first { $0.tick == .needsFix }
    }

    static func configuredAgents(_ r: EngineReport) -> [EngineStep] {
        r.steps(prefix: "agent-").filter { $0.id != "agent-manual" && $0.state == .ok && aiName($0.id) != nil }
    }

    /// Config written → client loaded it → FigmaMCP open in Figma → first AI request answered.
    public static func connection(_ s: Snapshot) -> [ConnState] {
        guard let r = s.report else { return [] }
        let configured = configuredAgents(r)
        let names = configured.compactMap { aiName($0.id) }
        var out: [ConnState] = []
        out.append(.init(kind: .config, tick: configured.isEmpty ? .needsFix : .good,
                         title: L10n.t("Setting in your AI app", "AI 应用中的设置"),
                         detail: configured.isEmpty ? L10n.t("Not set up in Claude Code or Codex yet", "还没有在 Claude Code 或 Codex 中设置")
                                                    : L10n.t("\(L10n.and(names)) set up", "已为 \(L10n.and(names)) 设置")))
        let counts = configured.map { ($0, r.loaded[$0.id]) }
        let notLoaded = counts.filter { $0.1 == 0 }.compactMap { aiName($0.0.id) }
        let loadedTick: ConnTick
        let loadedDetail: String
        if configured.isEmpty {
            loadedTick = .waiting; loadedDetail = L10n.t("Waiting for the step above", "等待上一步")
        } else if counts.allSatisfy({ $0.1 == nil }) {
            loadedTick = .unknown
            loadedDetail = L10n.t("If \(L10n.or(names)) was open during setup, restart it once.",
                                  "如果设置时 \(L10n.or(names)) 已经打开，请重启一次。")
        } else if counts.allSatisfy({ $0.1 == 0 }) {
            loadedTick = .needsFix
            loadedDetail = L10n.t("Open or restart \(L10n.and(notLoaded)) (quit it and open it again) so it loads FigmaMCP.",
                                  "请打开或重启 \(L10n.and(notLoaded))（完全退出后再打开），让它加载 FigmaMCP。")
        } else {
            let loadedNames = counts.filter { ($0.1 ?? 0) > 0 }.compactMap { aiName($0.0.id) }
            loadedTick = .good
            loadedDetail = L10n.t("\(L10n.and(loadedNames)) loaded FigmaMCP", "\(L10n.and(loadedNames)) 已加载 FigmaMCP")
                + (notLoaded.isEmpty ? "" : L10n.t(". To use \(L10n.and(notLoaded)) too, open or restart it.",
                                                   "。如果也要用 \(L10n.and(notLoaded))，请打开或重启它。"))
        }
        out.append(.init(kind: .loaded, tick: loadedTick, title: L10n.t("Loaded by your AI app", "AI 应用加载情况"), detail: loadedDetail))
        let open = pluginOpen(r)
        let file = r.currentFile ?? r.openFiles.first { !$0.outdated }?.name
        out.append(.init(kind: .pluginOnline, tick: open ? .good : .needsFix,
                         title: L10n.t("FigmaMCP in a Figma file", "Figma 文件中的 FigmaMCP"),
                         detail: open ? (file.map { L10n.t("Open in \(L10n.quote($0))", "已在 \(L10n.quote($0)) 中打开") } ?? L10n.t("Open in a Figma file", "已在一个 Figma 文件中打开"))
                                      : L10n.t("Not open in any Figma file. In Figma: Plugins › Development › FigmaMCP.",
                                               "还没有在任何 Figma 文件中打开。在 Figma 中选择：Plugins（插件）› Development（开发）› FigmaMCP。")))
        let done = s.firstCallSeen || r.openFiles.contains { ($0.completedCalls ?? 0) > 0 }
        out.append(.init(kind: .firstCall, tick: done ? .good : .waiting,
                         title: L10n.t("First AI request", "第一次 AI 请求"),
                         detail: done ? L10n.t("Your AI has edited or read a Figma file", "AI 已经读取或编辑过 Figma 文件")
                                      : L10n.t("Ask your AI to use FigmaMCP", "让 AI 使用 FigmaMCP 试一次")))
        return out
    }

    /// First thing to ask the AI. Names Figma and FigmaMCP so the agent picks the right tool, and only reads.
    public static func trySentence(file: String?) -> String {
        if L10n.lang == .zh {
            let f = file.map { " \(L10n.quote($0))" } ?? ""
            return "用 FigmaMCP 看一下我打开的 Figma 文件\(f)，提出三个改进布局的建议。先不要做任何修改。"
        }
        let f = file.map { " \u{201C}\($0)\u{201D}" } ?? ""
        return "Use FigmaMCP to look at my open Figma file\(f) and suggest three ways to improve the layout. Don't change anything yet."
    }

    public static func addonReady(_ r: EngineReport) -> Bool {
        r.step("plugin")?.state == .ok
    }

    /// Figma reads its add-on list at launch, so only a missing add-on needs a restart.
    public static func needsFigmaRestart(_ s: Snapshot) -> Bool {
        guard s.figmaRunning, let r = s.report else { return false }
        return !addonReady(r) && !needsFigmaFirstOpen(s)
    }

    /// Figma is installed but has never been opened, so it has no settings yet and FigmaMCP cannot be added.
    /// The app was updated and carries a newer engine, but setup was finished before (FigmaMCP is in Figma and an
    /// AI app is connected). Only the files, the relay and the skill are behind, so the app updates them itself:
    /// nothing to approve, and Figma does not restart.
    public static func needsQuietUpdate(_ s: Snapshot) -> Bool {
        guard let r = s.report, r.step("runtime")?.state == .todo, r.step("plugin")?.state == .ok,
              r.steps(prefix: "agent-").contains(where: { $0.state == .ok }) else { return false }
        let quiet: Set<String> = ["runtime", "relay", "skill"]
        return r.steps.allSatisfy { $0.state == .ok || quiet.contains($0.id) }
    }

    public static func needsFigmaFirstOpen(_ s: Snapshot) -> Bool {
        s.report?.step("plugin")?.rawState == "needs-figma-launch"
    }

    /// Background parts (runtime, helper, runtime tools). Any not-ok blocks use.
    public static func backgroundSteps(_ r: EngineReport) -> [EngineStep] {
        r.steps.filter { ["runtime", "relay", "node", "platform"].contains($0.id) }
    }

    public static func backgroundReady(_ r: EngineReport) -> Bool {
        backgroundSteps(r).allSatisfy { $0.state == .ok || $0.state == .skip }
    }

    public static func accessOK(_ s: Snapshot) -> Bool { s.accessGranted }

    // MARK: first-run stage

    public static func stage(_ s: Snapshot) -> SetupStage {
        guard let r = s.report else { return s.engineError == nil ? .checking : .engineProblem }
        if !figmaInstalled(r) { return .installFigma }
        if !aiDetected(r) { return .connectAI }
        if !addonReady(r) || !anyAIConnected(r) || !backgroundReady(r) { return .addToFigma }
        if !s.accessGranted && !s.accessSkipped { return .allowOpening }
        if !s.pluginSeen && !s.openSkipped { return .openInFigma }
        return .done
    }

    public enum Tick: Equatable, Sendable { case done, current, waiting, skipped }

    /// Checklist ticks for the first-run window, in display order.
    public static func checklist(_ s: Snapshot) -> [(kind: ItemKind, tick: Tick)] {
        let st = stage(s)
        let order: [(ItemKind, SetupStage)] = [(.figma, .installFigma), (.ai, .connectAI), (.addon, .addToFigma), (.access, .allowOpening), (.open, .openInFigma)]
        let currentIndex: Int? = order.firstIndex { $0.1 == st }
        return order.enumerated().map { i, pair in
            if pair.0 == .access && !s.accessGranted && s.accessSkipped, st == .done || st == .openInFigma { return (pair.0, .skipped) }
            if st == .done { return (pair.0, pair.0 == .open && !s.pluginSeen ? .skipped : .done) }
            if let c = currentIndex { return (pair.0, i < c ? .done : (i == c ? .current : .waiting)) }
            return (pair.0, .waiting) // checking / engine problem
        }
    }

    // MARK: per-item health (menu popover)

    public static func health(_ s: Snapshot) -> [HealthItem] {
        guard let r = s.report else { return [] }
        var items: [HealthItem] = []
        if figmaInstalled(r) {
            items.append(.init(kind: .figma, health: .good, title: L10n.t("Figma app", "Figma 应用"),
                               detail: s.figmaRunning ? L10n.t("Installed and open", "已安装，已打开") : L10n.t("Installed, not open", "已安装，未打开"), fix: nil, fixLabel: nil))
        } else {
            items.append(.init(kind: .figma, health: .needsFix, title: L10n.t("Figma app", "Figma 应用"), detail: L10n.t("Not found on this Mac", "这台 Mac 上没有找到"),
                               fix: .installFigma, fixLabel: L10n.t("Get Figma", "下载 Figma")))
        }
        if aiConnected(r) {
            items.append(.init(kind: .ai, health: .good, title: L10n.t("Your AI", "你的 AI"), detail: L10n.t(L10n.and(aiNames(r)) + " set up", "已为 " + L10n.and(aiNames(r)) + " 设置"), fix: nil, fixLabel: nil))
        } else if aiDetected(r) {
            let present = r.steps(prefix: "agent-").filter { $0.id != "agent-manual" && $0.state != .skip }
            func names(_ ok: Bool) -> String {
                L10n.and(present.filter { ($0.state == .ok) == ok }.compactMap { aiName($0.id) })
            }
            let connected = names(true)
            let detail = connected.isEmpty ? L10n.t(names(false) + " is not set up yet", names(false) + " 还没有设置")
                : L10n.t(connected + " set up. " + names(false) + " is not set up yet", "已为 " + connected + " 设置。" + names(false) + " 还没有设置")
            items.append(.init(kind: .ai, health: .needsFix, title: L10n.t("Your AI", "你的 AI"), detail: detail,
                               fix: .setUp, fixLabel: L10n.t("Set up", "设置")))
        } else {
            items.append(.init(kind: .ai, health: .needsFix, title: L10n.t("Your AI", "你的 AI"), detail: L10n.t("Claude Code or Codex not found", "没有找到 Claude Code 或 Codex"),
                               fix: .openAIHelp, fixLabel: L10n.t("How to get one", "如何获取")))
        }
        let bgOK = backgroundReady(r)
        if !addonReady(r) && needsFigmaFirstOpen(s) {
            items.append(.init(kind: .addon, health: .needsFix, title: L10n.t("FigmaMCP in Figma", "Figma 中的 FigmaMCP"),
                               detail: s.figmaRunning ? L10n.t("Waiting for Figma to finish opening", "等待 Figma 打开完成") : L10n.t("Figma has to open once before FigmaMCP can be added", "需要先打开一次 Figma，才能添加 FigmaMCP"),
                               fix: s.figmaRunning ? nil : .launchFigma, fixLabel: s.figmaRunning ? nil : L10n.t("Open Figma", "打开 Figma")))
        } else if addonReady(r) && bgOK {
            items.append(.init(kind: .addon, health: .good, title: L10n.t("FigmaMCP in Figma", "Figma 中的 FigmaMCP"), detail: L10n.t("Added", "已添加"), fix: nil, fixLabel: nil))
        } else {
            let why = backgroundSteps(r).first { $0.state == .fail }?.message
            let detail = addonReady(r) ? (PlainEnglish.safe(why) ?? L10n.t("Something stopped working in the background", "后台有部分功能停止了工作")) : L10n.t("Not added to Figma yet", "还没有添加到 Figma")
            items.append(.init(kind: .addon, health: .needsFix, title: L10n.t("FigmaMCP in Figma", "Figma 中的 FigmaMCP"), detail: detail,
                               fix: .setUp, fixLabel: addonReady(r) ? L10n.t("Fix", "修复") : L10n.t("Add", "添加")))
        }
        if let notice = outdatedNotice(r) {
            items.append(.init(kind: .open, health: .needsFix, title: L10n.t("FigmaMCP panel", "FigmaMCP 面板"), detail: notice, fix: nil, fixLabel: nil))
        }
        if s.accessGranted {
            items.append(.init(kind: .access, health: .good, title: L10n.t("Open things in Figma", "在 Figma 中打开"), detail: L10n.t("Allowed", "已允许"), fix: nil, fixLabel: nil))
        } else {
            items.append(.init(kind: .access, health: .optional, title: L10n.t("Open things in Figma", "在 Figma 中打开"),
                               detail: L10n.t("Not allowed. You can open FigmaMCP in Figma yourself.", "未允许。你可以自己在 Figma 中打开 FigmaMCP。"), fix: .allowOpening, fixLabel: L10n.t("Allow", "允许")))
        }
        return items
    }

    public static func menuStatus(_ s: Snapshot) -> MenuStatus {
        guard s.report != nil else { return .needsAttention }
        if health(s).contains(where: { $0.health == .needsFix }) { return .needsAttention }
        return s.figmaRunning ? .ready : .figmaClosed
    }

    /// Stage after which the first-run window should not reopen by itself.
    public static func isSetUp(_ s: Snapshot) -> Bool {
        stage(s) == .done
    }
}
