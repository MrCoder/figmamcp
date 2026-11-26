import SwiftUI

/// Small drawn pictures. They show where to look; they are not screenshots, so they never go stale.
struct MockCard<Content: View>: View {
    var content: Content
    init(@ViewBuilder _ c: () -> Content) { content = c() }
    var body: some View {
        content
            .padding(8)
            .frame(maxWidth: .infinity, minHeight: 78, maxHeight: 78, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.12)))
    }
}

struct Bar: View {
    var width: CGFloat = 40
    var body: some View {
        RoundedRectangle(cornerRadius: 2).fill(Color.primary.opacity(0.12)).frame(width: width, height: 5)
    }
}

struct MockRow: View {
    var label: String?
    var highlight = false
    var toggle: Bool? = nil
    var body: some View {
        HStack(spacing: 4) {
            if let label { Text(label).font(.system(size: 9, weight: highlight ? .semibold : .regular)).lineLimit(1).minimumScaleFactor(0.7) }
            else { Bar(width: 34) }
            Spacer(minLength: 2)
            if let toggle {
                Capsule().fill(toggle ? Color.accentColor : Color.secondary.opacity(0.35))
                    .frame(width: 18, height: 10)
                    .overlay(alignment: toggle ? .trailing : .leading) { Circle().fill(.white).frame(width: 8, height: 8).padding(1) }
            }
        }
        .padding(.horizontal, 5).padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 4).fill(highlight ? Color.accentColor.opacity(0.22) : .clear))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(highlight ? Color.accentColor : .clear, lineWidth: 1))
    }
}

struct GuideStep<Pic: View>: View {
    var number: Int
    var text: String
    var pic: Pic
    init(_ number: Int, _ text: String, @ViewBuilder pic: () -> Pic) { self.number = number; self.text = text; self.pic = pic() }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MockCard { pic }
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text("\(number)").font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(width: 10)
                Text(text).font(.caption).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// How to switch on the permission in System Settings.
public struct AccessGuideView: View {
    public init() {}
    public var body: some View {
        HStack(alignment: .top, spacing: 10) {
            GuideStep(1, L10n.t("Click Open System Settings below.", "点击下方的“打开系统设置”。")) {
                VStack(alignment: .leading, spacing: 2) {
                    MockRow(label: nil); MockRow(label: L10n.t("Privacy & Security › Accessibility", "隐私与安全性 › 辅助功能"), highlight: true); MockRow(label: nil)
                }
            }
            GuideStep(2, L10n.t("Find FigmaMCP in the list.", "在“隐私与安全性 › 辅助功能”列表中找到 FigmaMCP。")) {
                VStack(spacing: 2) {
                    MockRow(label: "Figma", toggle: false); MockRow(label: "FigmaMCP", highlight: true, toggle: false); MockRow(label: nil, toggle: false)
                }
            }
            GuideStep(3, L10n.t("Turn it on. Enter your Mac password if asked.", "打开开关。如有提示，输入 Mac 密码。")) {
                VStack(spacing: 2) {
                    MockRow(label: "Figma", toggle: false); MockRow(label: "FigmaMCP", highlight: true, toggle: true); MockRow(label: nil, toggle: false)
                }
            }
        }
    }
}

/// How to open FigmaMCP by hand from Figma's menu.
public struct ManualOpenGuideView: View {
    public init() {}
    public var body: some View {
        HStack(alignment: .top, spacing: 10) {
            GuideStep(1, L10n.t("In Figma, open the file you want to edit.", "在 Figma 中打开要编辑的文件。")) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 4) { Circle().fill(.red.opacity(0.6)).frame(width: 5); Circle().fill(.yellow.opacity(0.7)).frame(width: 5); Circle().fill(.green.opacity(0.6)).frame(width: 5) }
                    Bar(width: 70); Bar(width: 50)
                }
            }
            GuideStep(2, L10n.t("Choose Plugins, then Development.", "选择 Plugins（插件），再选 Development（开发）。")) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) { Bar(width: 20); Text("Plugins").font(.system(size: 9, weight: .semibold)).padding(.horizontal, 3).background(RoundedRectangle(cornerRadius: 3).fill(Color.accentColor.opacity(0.25))) }
                    MockRow(label: "Development", highlight: true); MockRow(label: nil)
                }
            }
            GuideStep(3, L10n.t("Click FigmaMCP.", "点击 FigmaMCP。")) {
                VStack(spacing: 2) {
                    MockRow(label: "Development"); MockRow(label: "FigmaMCP", highlight: true); MockRow(label: nil)
                }
            }
        }
    }
}

/// What the FigmaMCP panel looks like in Figma once it is connected. Mirrors figma_plugin/ui.html.
struct PluginPanelMock: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Circle().fill(Color.green).frame(width: 7, height: 7)
                Text("Connected").font(.system(size: 9, weight: .semibold))
            }
            Rectangle().fill(Color.primary.opacity(0.1)).frame(height: 1)
            HStack(spacing: 4) {
                Text("AI can edit this file").font(.system(size: 8)).fixedSize()
                Spacer(minLength: 2)
                Capsule().fill(Color.accentColor).frame(width: 18, height: 10)
                    .overlay(alignment: .trailing) { Circle().fill(.white).frame(width: 8, height: 8).padding(1) }
            }
        }
    }
}

/// How to get FigmaMCP open in a Figma file, ending with what the user should see.
public struct OpenGuideView: View {
    var manual: Bool
    public init(manual: Bool) { self.manual = manual }
    public var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if manual {
                GuideStep(1, L10n.t("Open or create a design file.", "打开或新建一个设计文件。")) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 4) { Circle().fill(.red.opacity(0.6)).frame(width: 5); Circle().fill(.yellow.opacity(0.7)).frame(width: 5); Circle().fill(.green.opacity(0.6)).frame(width: 5) }
                        Bar(width: 70); Bar(width: 50)
                    }
                }
                GuideStep(2, L10n.t("Choose Plugins, then Development.", "选择 Plugins（插件），再选 Development（开发）。")) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 8) { Bar(width: 20); Text("Plugins").font(.system(size: 9, weight: .semibold)).padding(.horizontal, 3).background(RoundedRectangle(cornerRadius: 3).fill(Color.accentColor.opacity(0.25))) }
                        MockRow(label: "Development", highlight: true); MockRow(label: nil)
                    }
                }
                GuideStep(3, L10n.t("Click FigmaMCP.", "点击 FigmaMCP。")) {
                    VStack(spacing: 2) { MockRow(label: "Development"); MockRow(label: "FigmaMCP", highlight: true); MockRow(label: nil) }
                }
            }
            GuideStep(manual ? 4 : 1, L10n.t("You should see this in Figma. Leave it open.", "Figma 中应显示这个面板。请保持打开。")) { PluginPanelMock() }
                .frame(maxWidth: manual ? .infinity : 220)
        }
    }
}

/// Text-only button in the accent colour. Used instead of `.link` so it also draws in rendered previews.
struct TextButton: View {
    var title: String
    var action: () -> Void
    init(_ t: String, action: @escaping () -> Void) { title = t; self.action = action }
    var body: some View {
        Button(action: action) { Text(title).foregroundStyle(Color.accentColor) }.buttonStyle(.plain)
    }
}
