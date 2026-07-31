import Foundation

public struct HistoryArchive: Codable, Sendable {
    public var downloads: [DownloadTask]
    public var searches: [SearchHistoryEntry]

    public init(downloads: [DownloadTask] = [], searches: [SearchHistoryEntry] = []) {
        self.downloads = downloads
        self.searches = searches
    }
}
