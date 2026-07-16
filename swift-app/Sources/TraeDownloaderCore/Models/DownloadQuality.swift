import Foundation

public enum DownloadQuality: String, Codable, CaseIterable, Identifiable, Sendable {
    case best
    case p1080 = "1080p"
    case p720 = "720p"
    case p480 = "480p"

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .best:
            return "最佳"
        case .p1080:
            return "1080p"
        case .p720:
            return "720p"
        case .p480:
            return "480p"
        }
    }

    public var ytDlpFormat: String {
        switch self {
        case .best:
            return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
        case .p1080:
            return "bestvideo[height<=1080]+bestaudio/best"
        case .p720:
            return "bestvideo[height<=720]+bestaudio/best"
        case .p480:
            return "bestvideo[height<=480]+bestaudio/best"
        }
    }
}
