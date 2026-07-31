import Foundation

public struct DownloadOptions: Codable, Hashable, Sendable {
    public var formatID: String?
    public var quality: DownloadQuality
    public var downloadSubtitles: Bool
    public var outputPath: String
    public var speedLimit: Int?
    public var proxy: String?

    public init(
        formatID: String? = nil,
        quality: DownloadQuality = .best,
        downloadSubtitles: Bool = false,
        outputPath: String = DownloadOptions.defaultDownloadDirectory(),
        speedLimit: Int? = nil,
        proxy: String? = nil
    ) {
        self.formatID = formatID
        self.quality = quality
        self.downloadSubtitles = downloadSubtitles
        self.outputPath = outputPath
        self.speedLimit = speedLimit
        self.proxy = proxy
    }

    public static func defaultDownloadDirectory() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home
            .appendingPathComponent("Downloads")
            .appendingPathComponent("TraeDownloader")
            .path
    }
}
