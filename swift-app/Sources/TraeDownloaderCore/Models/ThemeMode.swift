import Foundation

public enum ThemeMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case system
    case light
    case dark

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .system:
            return "系统"
        case .light:
            return "浅色"
        case .dark:
            return "深色"
        }
    }
}
