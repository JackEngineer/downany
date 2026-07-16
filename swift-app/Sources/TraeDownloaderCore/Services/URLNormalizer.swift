import Foundation

public enum URLNormalizer {
    private static let youtubeIDPattern = #"^[0-9A-Za-z_-]{11}$"#
    private static let bilibiliBVPattern = #"(?i)^BV[0-9A-Za-z]{10}$"#

    public static func normalize(_ rawValue: String) -> String {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            return ""
        }

        if value.hasPrefix("http://") || value.hasPrefix("https://") {
            return value
        }

        if value.range(of: bilibiliBVPattern, options: .regularExpression) != nil {
            return "https://www.bilibili.com/video/\(value.uppercased())"
        }

        if value.range(of: youtubeIDPattern, options: .regularExpression) != nil {
            return "https://www.youtube.com/watch?v=\(value)"
        }

        return value
    }
}
