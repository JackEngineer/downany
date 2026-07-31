import Foundation

public actor HistoryStore {
    private let fileURL: URL
    private let queueFileURL: URL
    private var archive: HistoryArchive
    private var nextSearchID: Int

    public init(baseDirectory: URL? = nil, fileManager: FileManager = .default) {
        let rootDirectory = baseDirectory ?? HistoryStore.defaultRootDirectory(fileManager: fileManager)
        self.fileURL = rootDirectory.appendingPathComponent("history.json")
        self.queueFileURL = rootDirectory.appendingPathComponent("active_queue.json")

        if let data = try? Data(contentsOf: fileURL),
           let decoded = try? HistoryStore.decoder.decode(HistoryArchive.self, from: data) {
            self.archive = decoded
        } else {
            self.archive = HistoryArchive()
        }

        self.nextSearchID = (archive.searches.map(\.id).max() ?? 0) + 1
    }

    public func loadDownloadTasks(limit: Int? = nil) -> [DownloadTask] {
        let sorted = archive.downloads.sorted { $0.createdAt > $1.createdAt }
        guard let limit else {
            return sorted
        }
        return Array(sorted.prefix(limit))
    }

    public func upsertDownloadTask(_ task: DownloadTask) throws {
        if let index = archive.downloads.firstIndex(where: { $0.id == task.id }) {
            archive.downloads[index] = task
        } else {
            archive.downloads.append(task)
        }
        try save()
    }

    public func deleteDownloadTask(id: UUID) throws {
        archive.downloads.removeAll { $0.id == id }
        try save()
    }

    public func searchDownloadTasks(query: String, limit: Int = 100) -> [DownloadTask] {
        let needle = query.lowercased()
        let matches = archive.downloads.filter { task in
            task.displayTitle.lowercased().contains(needle)
                || task.videoInfo.url.lowercased().contains(needle)
                || task.videoInfo.uploader.lowercased().contains(needle)
        }
        return Array(matches.sorted { $0.createdAt > $1.createdAt }.prefix(limit))
    }

    public func appendSearch(platform: Platform, query: String) throws {
        // 去重：同平台同 query 移到最新
        archive.searches.removeAll { $0.platform == platform && $0.query == query }
        archive.searches.append(SearchHistoryEntry(id: nextSearchID, platform: platform, query: query))
        nextSearchID += 1
        if archive.searches.count > 200 {
            archive.searches = Array(archive.searches.suffix(200))
        }
        try save()
    }

    public func recentSearches(limit: Int = 20) -> [SearchHistoryEntry] {
        Array(archive.searches.sorted { $0.searchedAt > $1.searchedAt }.prefix(limit))
    }

    public func removeSearch(id: Int) throws {
        archive.searches.removeAll { $0.id == id }
        try save()
    }

    /// 持久化未完成队列；下载中任务会以 PENDING 语义写盘，避免假恢复半文件。
    public func saveActiveQueue(_ tasks: [DownloadTask]) throws {
        try Self.ensureDirectoryExists(queueFileURL.deletingLastPathComponent())
        let data = try HistoryStore.encoder.encode(tasks)
        try data.write(to: queueFileURL, options: [.atomic])
    }

    public func loadActiveQueue() -> [DownloadTask] {
        guard let data = try? Data(contentsOf: queueFileURL),
              let tasks = try? HistoryStore.decoder.decode([DownloadTask].self, from: data) else {
            return []
        }
        return tasks
    }

    public func clearActiveQueue() throws {
        try saveActiveQueue([])
    }

    private func save() throws {
        try Self.ensureDirectoryExists(fileURL.deletingLastPathComponent())
        let data = try HistoryStore.encoder.encode(archive)
        try data.write(to: fileURL, options: [.atomic])
    }

    private static func defaultRootDirectory(fileManager: FileManager) -> URL {
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.homeDirectoryForCurrentUser
        return appSupport.appendingPathComponent("TraeDownloaderSwift", isDirectory: true)
    }

    private static func ensureDirectoryExists(_ directoryURL: URL) throws {
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true, attributes: nil)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
