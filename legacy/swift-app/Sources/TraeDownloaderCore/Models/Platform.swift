import Foundation

public enum Platform: String, Codable, CaseIterable, Identifiable, Sendable {
    case youtube
    case bilibili
    case douyin
    case tiktok
    case twitter
    case instagram
    case pornhub
    case unknown

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .youtube:
            return "YouTube"
        case .bilibili:
            return "Bilibili"
        case .douyin:
            return "抖音"
        case .tiktok:
            return "TikTok"
        case .twitter:
            return "X / Twitter"
        case .instagram:
            return "Instagram"
        case .pornhub:
            return "Pornhub"
        case .unknown:
            return "未知"
        }
    }

    public var icon: String {
        switch self {
        case .youtube:
            return "▶"
        case .bilibili:
            return "B"
        case .douyin, .tiktok:
            return "♪"
        case .twitter:
            return "X"
        case .instagram:
            return "⌁"
        case .pornhub:
            return "18+"
        case .unknown:
            return "?"
        }
    }

    public var accentHex: String {
        switch self {
        case .youtube:
            return "#FF0000"
        case .bilibili:
            return "#00A1D6"
        case .douyin, .tiktok:
            return "#000000"
        case .twitter:
            return "#1DA1F2"
        case .instagram:
            return "#E4405F"
        case .pornhub:
            return "#FF9900"
        case .unknown:
            return "#808080"
        }
    }

    public var searchPrefix: String? {
        switch self {
        case .youtube:
            return "ytsearch"
        case .bilibili:
            return "bilisearch"
        case .pornhub:
            return "phsearch"
        case .douyin, .tiktok, .twitter, .instagram, .unknown:
            return nil
        }
    }
}
