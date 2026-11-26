import SwiftUI
import AppKit

public struct PopoverView: View {
    @ObservedObject var model: AppModel
    var quit: () -> Void
    public init(model: AppModel, quit: @escaping () -> Void = { NSApp.terminate(nil) }) { self.model = model; self.quit = quit }

    public static let width: CGFloat = 340

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if model.showAccessGuide { guide } else { actions }
            if let v = model.availableUpdate {
                Button(L10n.t("Update available: v\(v)", "有新版本：v\(v)")) { model.openUpdatePage() }
                    .buttonStyle(.link).font(.callout)
            }
            Divider()
            footer
        }
        .padding(16)
        .frame(width: Self.width)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    var header: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: model.status.symbol).font(.title2).foregroundStyle(statusColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.status.label).font(.headline)
                Text(subtitle).font(.callout).foregroundStyle(.secondary).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
    }

    var statusColor: Color {
        switch model.status { case .ready: return .green; case .needsAttention: return .orange; case .figmaClosed: return .secondary }
    }

    var subtitle: String {
        if model.status == .ready, let p = Flow.firstConnectionProblem(model.snapshot) { return p.detail }
        switch model.status {
        case .ready: return model.currentFile.map { L10n.t("Working in \($0)", "正在编辑 \($0)") } ?? L10n.t("Open a file in Figma to start", "在 Figma 中打开一个文件即可开始")
        case .figmaClosed: return L10n.t("Open Figma to start", "打开 Figma 即可开始")
        case .needsAttention: return L10n.t("Something needs a quick fix", "有一项需要处理")
        }
    }

    var actions: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button { Task { await model.openInFigma() } } label: {
                HStack { Spacer(); if model.busy { ProgressView().controlSize(.small) }; Text(model.busy ? L10n.t("Opening", "正在打开") : L10n.t("Open in Figma", "在 Figma 中打开")); Spacer() }
            }
            .buttonStyle(.borderedProminent).controlSize(.large).disabled(model.busy)
            if let n = model.notice { Text(n).font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            VStack(spacing: 2) {
                ForEach(model.health) { item in HealthRow(item: item) { model.perform($0) } }
            }
            Divider()
            ConnectionList(states: model.connection, compact: true)
        }
    }

    var guide: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t("FigmaMCP needs your OK to open things in Figma. Switch it on once:", "FigmaMCP 需要你允许它在 Figma 中打开内容。打开一次即可：")).font(.callout)
            AccessGuideView().scaleEffect(1, anchor: .topLeading)
            HStack {
                Button(L10n.t("Open System Settings", "打开系统设置")) { model.requestAccess() }.buttonStyle(.borderedProminent)
                Button(L10n.t("Back", "返回")) { model.showAccessGuide = false }
            }
            Text(L10n.t("Or open it yourself:", "或者自己打开：")).font(.callout).foregroundStyle(.secondary)
            ManualOpenGuideView()
        }
    }

    var footer: some View {
        HStack {
            TextButton(L10n.t("Set up again", "重新设置")) { model.setUpAgain() }
            Spacer()
            DiagnosticsButton(model: model)
            Spacer()
            Toggle(L10n.t("Start at login", "登录时启动"), isOn: Binding(get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }))
                .toggleStyle(.checkbox).font(.callout)
            Spacer()
            TextButton(L10n.t("Quit", "退出"), action: quit)
        }
        .font(.callout)
    }
}

struct HealthRow: View {
    var item: HealthItem
    var fix: (Fix) -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon).foregroundStyle(color).frame(width: 18)
            VStack(alignment: .leading, spacing: 0) {
                Text(item.title).font(.callout)
                Text(item.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            if let f = item.fix, let l = item.fixLabel { Button(l) { fix(f) }.controlSize(.small) }
        }
        .padding(.vertical, 5)
    }

    var icon: String {
        switch item.health { case .good: return "checkmark.circle.fill"; case .needsFix: return "exclamationmark.circle.fill"; case .optional: return "minus.circle" }
    }
    var color: Color {
        switch item.health { case .good: return .green; case .needsFix: return .orange; case .optional: return .secondary }
    }
}
