import SwiftUI
import AppKit


public struct FirstRunView: View {
    @ObservedObject var model: AppModel
    @State private var copied = false
    public init(model: AppModel) { self.model = model }

    public static let size = CGSize(width: 560, height: 640)

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.stage == .done { doneBody } else { setupBody }
        }
        .padding(28)
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: setup

    var setupBody: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n.t("Let AI edit your Figma files", "让 AI 编辑你的 Figma 文件")).font(.title2.weight(.semibold))
                Text(L10n.t("A few quick steps. It takes about a minute.", "只需几步，大约一分钟。")).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(Flow.checklist(model.snapshot).enumerated()), id: \.offset) { _, row in
                    ChecklistRow(kind: row.kind, tick: row.tick, model: model)
                }
            }
            Spacer(minLength: 0)
            if let msg = model.notice ?? model.engineMessage {
                Label(msg, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange)
            }
        }
    }

    // MARK: done

    var sentence: String { Flow.trySentence(file: model.currentFile) }

    var doneTitle: String {
        if let f = model.currentFile { return L10n.t("FigmaMCP is open in \(L10n.quote(f))", "FigmaMCP 已在 \(L10n.quote(f)) 中打开") }
        return L10n.t("You're all set", "设置完成")
    }

    var doneSubtitle: String {
        let names = model.snapshot.report.map(Flow.connectedAINames) ?? []
        let who = names.isEmpty ? L10n.t("your AI", "你的 AI") : L10n.or(names)
        if model.currentFile != nil { return L10n.t("Now ask \(who) something like this:", "现在可以这样问 \(who)：") }
        return L10n.t("Open FigmaMCP in a Figma file, then ask \(who) something like this:", "先在 Figma 文件中打开 FigmaMCP，然后这样问 \(who)：")
    }

    var doneBody: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 40)).foregroundStyle(.green)
            VStack(alignment: .leading, spacing: 4) {
                Text(doneTitle).font(.title2.weight(.semibold))
                Text(doneSubtitle).foregroundStyle(.secondary)
            }
            Text(sentence)
                .font(.title3)
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.1)))
            HStack {
                Button { copy() } label: { Label(copied ? L10n.t("Copied", "已复制") : L10n.t("Copy sentence", "复制这句话"), systemImage: copied ? "checkmark" : "doc.on.doc") }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                Button(L10n.t("Open in Figma", "在 Figma 中打开")) { Task { await model.openInFigma() } }.controlSize(.large)
            }
            if let n = model.notice { Text(n).font(.callout).foregroundStyle(.orange) }
            if let old = model.snapshot.report.flatMap(Flow.outdatedNotice) {
                Label(old, systemImage: "exclamationmark.triangle.fill").font(.callout).foregroundStyle(.orange)
            }
            ConnectionList(states: model.connection)
            if model.currentFile == nil && !model.snapshot.accessGranted {
                VStack(alignment: .leading, spacing: 8) {
                    Text(L10n.t("To open FigmaMCP yourself:", "自己打开 FigmaMCP：")).font(.callout.weight(.medium))
                    OpenGuideView(manual: true)
                }
            }
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 4) {
                Label(L10n.t("FigmaMCP now lives in your menu bar.", "FigmaMCP 现在在菜单栏中。"), systemImage: "menubar.arrow.up.rectangle")
                DiagnosticsButton(model: model)
            }.font(.callout).foregroundStyle(.secondary)
        }
    }

    func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(sentence, forType: .string)
        copied = true
    }
}

struct ChecklistRow: View {
    var kind: ItemKind
    var tick: Flow.Tick
    @ObservedObject var model: AppModel

    var title: String {
        switch kind {
        case .figma: return L10n.t("Figma is installed", "已安装 Figma")
        case .ai: return L10n.t("Connect your AI", "设置你的 AI")
        case .addon: return L10n.t("Add FigmaMCP to Figma", "把 FigmaMCP 添加到 Figma")
        case .access: return L10n.t("Let FigmaMCP open things in Figma", "允许 FigmaMCP 在 Figma 中打开")
        case .open: return L10n.t("Open FigmaMCP in a Figma file", "在 Figma 文件中打开 FigmaMCP")
        }
    }

    var subtitle: String? {
        guard let r = model.snapshot.report else { return nil }
        switch (kind, tick) {
        case (.ai, .done):
            let names = Flow.connectedAINames(r)
            return names.isEmpty ? L10n.t(L10n.and(Flow.aiNames(r)) + " found", "找到 " + L10n.and(Flow.aiNames(r)))
                : L10n.t(L10n.and(names) + " set up. If it was already open, restart it once.", "已为 " + L10n.and(names) + " 设置。如果它已经打开，请重启一次。")
        case (.open, .done): return model.currentFile.map { L10n.t("Open in \(L10n.quote($0))", "已在 \(L10n.quote($0)) 中打开") }
        case (.open, .skipped): return L10n.t("Skipped. Open it from Figma's Plugins menu when you need it.", "已跳过。需要时从 Figma 的 Plugins（插件）菜单打开。")
        case (.access, .skipped): return L10n.t("Skipped. You can open FigmaMCP from Figma's menu.", "已跳过。你可以从 Figma 的菜单打开 FigmaMCP。")
        default: return nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                icon.frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).fontWeight(tick == .current ? .semibold : .regular)
                        .foregroundStyle(tick == .waiting ? .secondary : .primary)
                    if let s = subtitle { Text(s).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
            }
            if tick == .current { StageDetail(kind: kind, model: model).padding(.leading, 32) }
        }
        .padding(.vertical, 8).padding(.horizontal, 10)
        .background(RoundedRectangle(cornerRadius: 10).fill(tick == .current ? Color(nsColor: .controlBackgroundColor) : .clear))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(tick == .current ? Color.primary.opacity(0.1) : .clear))
    }

    @ViewBuilder var icon: some View {
        switch tick {
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).font(.title3)
        case .skipped: Image(systemName: "minus.circle").foregroundStyle(.secondary).font(.title3)
        case .current: Image(systemName: "circle.dotted.circle").foregroundStyle(Color.accentColor).font(.title3)
        case .waiting: Image(systemName: "circle").foregroundStyle(.tertiary).font(.title3)
        }
    }
}

struct StageDetail: View {
    var kind: ItemKind
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch kind {
            case .figma:
                Text(L10n.t("FigmaMCP works with the Figma app for Mac. It isn't on this Mac yet.", "FigmaMCP 需要 Mac 版 Figma 应用，这台 Mac 上还没有安装。"))
                HStack(spacing: 10) {
                    Button(L10n.t("Get Figma", "下载 Figma")) { model.perform(.installFigma) }.buttonStyle(.borderedProminent).controlSize(.large)
                    Waiting(L10n.t("Looking for Figma", "正在查找 Figma"))
                }
            case .ai:
                Text(L10n.t("FigmaMCP lets Claude Code or Codex edit your Figma files. Neither is on this Mac yet.", "FigmaMCP 让 Claude Code 或 Codex 编辑你的 Figma 文件。这台 Mac 上两者都还没有安装。"))
                HStack(spacing: 10) {
                    Button(L10n.t("Get Claude Code", "获取 Claude Code")) { model.perform(.openAIHelp) }.buttonStyle(.borderedProminent).controlSize(.large)
                    Button(L10n.t("Get Codex", "获取 Codex")) { NSWorkspace.shared.open(URL(string: "https://developers.openai.com/codex/cli")!) }.controlSize(.large)
                }
                Waiting(L10n.t("Looking for your AI", "正在查找你的 AI"))
            case .addon where Flow.needsFigmaFirstOpen(model.snapshot):
                let open = model.snapshot.figmaRunning
                Text(open ? L10n.t("Figma is opening for the first time. This step continues once it is ready.", "Figma 正在第一次打开。打开完成后会继续这一步。")
                          : L10n.t("Figma has to open once before FigmaMCP can be added to it.", "需要先打开一次 Figma，才能把 FigmaMCP 添加进去。"))
                HStack(spacing: 10) {
                    if !open { Button(L10n.t("Open Figma", "打开 Figma")) { model.launchFigma() }.buttonStyle(.borderedProminent).controlSize(.large) }
                    Waiting(open ? L10n.t("Waiting for Figma", "等待 Figma") : L10n.t("Waiting for you", "等待你操作"))
                }
            case .addon:
                let running = Flow.needsFigmaRestart(model.snapshot)
                Text(running ? L10n.t("Figma has to restart once to pick this up. Your work is saved automatically, so nothing is lost.", "Figma 需要重启一次才能生效。你的工作会自动保存，不会丢失。")
                             : L10n.t("This adds FigmaMCP to Figma so your AI can use it.", "这一步会把 FigmaMCP 添加到 Figma，让你的 AI 可以使用。"))
                if let p = model.snapshot.report?.steps.first(where: { $0.state == .fail }) {
                    Text(PlainEnglish.safe(p.message) ?? L10n.t("Something got in the way last time. Trying again usually fixes it.", "上次被打断了。再试一次通常就能解决。"))
                        .font(.callout).foregroundStyle(.orange)
                }
                HStack(spacing: 10) {
                    Button(running ? L10n.t("Add and restart Figma", "添加并重启 Figma") : L10n.t("Add to Figma", "添加到 Figma")) { model.perform(.setUp) }
                        .buttonStyle(.borderedProminent).controlSize(.large).disabled(model.busy)
                    if model.busy { Waiting(running ? L10n.t("Adding. Figma will close and reopen.", "正在添加。Figma 会关闭后重新打开。") : L10n.t("Adding", "正在添加")) }
                }
            case .access:
                Text(L10n.t("To open FigmaMCP for you, macOS needs your OK to let it click Figma's menu. Nothing else is touched.", "为了替你打开 FigmaMCP，macOS 需要你允许它在“辅助功能”中点击 Figma 的菜单。不会操作其他任何内容。"))
                AccessGuideView()
                HStack(spacing: 14) {
                    Button(L10n.t("Open System Settings", "打开系统设置")) { model.requestAccess() }.buttonStyle(.borderedProminent).controlSize(.large)
                    TextButton(L10n.t("Skip for now", "暂时跳过")) { model.skipAccess() }
                    Spacer()
                    Waiting(L10n.t("Waiting for you", "等待你操作"))
                }
            case .open:
                Text(L10n.t("Last step. Your AI can only see a Figma file while FigmaMCP is open in it.", "最后一步。只有在 Figma 文件中打开了 FigmaMCP，你的 AI 才能看到这个文件。"))
                HStack(spacing: 10) {
                    if !model.snapshot.figmaRunning {
                        Button(L10n.t("Open Figma", "打开 Figma")) { model.launchFigma() }.buttonStyle(.borderedProminent).controlSize(.large)
                    } else if model.snapshot.accessGranted {
                        Button(L10n.t("Open FigmaMCP in Figma", "在 Figma 中打开 FigmaMCP")) { Task { await model.openInFigma() } }
                            .buttonStyle(.borderedProminent).controlSize(.large).disabled(model.busy)
                    }
                    Waiting(model.snapshot.figmaRunning ? L10n.t("Waiting for FigmaMCP to open", "等待 FigmaMCP 打开") : L10n.t("Waiting for Figma", "等待 Figma"))
                }
                if let n = model.notice { Text(n).foregroundStyle(.orange) }
                if let old = model.snapshot.report.flatMap(Flow.outdatedNotice) {
                    Label(old, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
                OpenGuideView(manual: model.snapshot.figmaRunning && !model.snapshot.accessGranted)
                TextButton(L10n.t("Skip for now", "暂时跳过")) { model.skipOpen() }
            }
        }
        .font(.callout)
    }
}

struct Waiting: View {
    var text: String
    init(_ t: String) { text = t }
    var body: some View {
        HStack(spacing: 6) { ProgressView().controlSize(.small); Text(text).foregroundStyle(.secondary) }
    }
}

/// The four separate states, so a written setting is never shown as a live link. The restart hint sits on its own row.
struct ConnectionList: View {
    var states: [ConnState]
    var compact = false
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 2 : 6) {
            ForEach(states) { st in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: icon(st.tick)).foregroundStyle(color(st.tick)).frame(width: 16)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(st.title).font(.callout)
                        Text(st.detail).font(.caption).foregroundStyle(st.tick == .needsFix ? .orange : .secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
    func icon(_ t: ConnTick) -> String {
        switch t { case .good: return "checkmark.circle.fill"; case .needsFix: return "exclamationmark.circle.fill"
        case .waiting: return "circle"; case .unknown: return "questionmark.circle" }
    }
    func color(_ t: ConnTick) -> Color {
        switch t { case .good: return .green; case .needsFix: return .orange; case .waiting, .unknown: return .secondary }
    }
}

struct DiagnosticsButton: View {
    @ObservedObject var model: AppModel
    var body: some View {
        TextButton(model.diagnosticsCopied ? L10n.t("Diagnostics copied", "已复制诊断信息") : L10n.t("Copy diagnostics", "复制诊断信息")) {
            Task { await model.copyDiagnostics() }
        }
    }
}
