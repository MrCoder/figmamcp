import Foundation

/// App copy in English and Simplified Chinese. Code-side on purpose: no bundle resources, so nothing changes in
/// build.sh or codesigning, and tests can switch the language. Traditional Chinese also gets Simplified Chinese,
/// which most zh-Hant readers can read; it is better than falling back to English.
public enum L10n {
    public enum Lang: Equatable, Sendable {
        case en, zh
        public static func from(_ preferred: [String]) -> Lang {
            (preferred.first ?? "").lowercased().hasPrefix("zh") ? .zh : .en
        }
    }

    nonisolated(unsafe) public static var lang: Lang = .from(Locale.preferredLanguages)

    public static func t(_ en: String, _ zh: String) -> String { lang == .zh ? zh : en }

    /// "A and B" / "A 和 B"
    public static func and(_ items: [String]) -> String { items.joined(separator: t(" and ", " 和 ")) }
    public static func or(_ items: [String]) -> String { items.joined(separator: t(" or ", " 或 ")) }
    public static func quote(_ s: String) -> String { lang == .zh ? "\u{201C}\(s)\u{201D}" : "\u{201C}\(s)\u{201D}" }
}
