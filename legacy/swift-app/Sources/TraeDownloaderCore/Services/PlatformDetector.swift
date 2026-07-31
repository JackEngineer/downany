import Foundation

public enum PlatformDetector {
    public static func detect(from rawValue: String) -> Platform {
        let normalized = URLNormalizer.normalize(rawValue).lowercased()
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)

        if normalized.contains("youtube.com/") || normalized.contains("youtu.be/") {
            return .youtube
        }

        if normalized.contains("bilibili.com/") || normalized.contains("b23.tv/") {
            return .bilibili
        }

        if normalized.contains("douyin.com/") {
            return .douyin
        }

        if normalized.contains("tiktok.com/") {
            return .tiktok
        }

        if normalized.contains("x.com/") || normalized.contains("twitter.com/") {
            return .twitter
        }

        if normalized.contains("instagram.com/") {
            return .instagram
        }

        if normalized.contains("pornhub.com/") {
            return .pornhub
        }

        if trimmed.range(of: #"^[0-9A-Za-z_-]{11}$"#, options: .regularExpression) != nil {
            return .youtube
        }

        if trimmed.range(of: #"(?i)^BV[0-9A-Za-z]{10}$"#, options: .regularExpression) != nil {
            return .bilibili
        }

        return .unknown
    }
}
