import AVFoundation
import AppKit
import Combine
import Foundation
import TraeDownloaderCore

@MainActor
public final class AppModel: ObservableObject {
    @Published public var searchQuery: String = ""
    @Published public var selectedPlatform: Platform = .youtube
    @Published public var searchResults: [VideoInfo] = []
    @Published public var queueTasks: [DownloadTask] = []
    @Published public var historyTasks: [DownloadTask] = []
    @Published public var recentSearches: [SearchHistoryEntry] = []
    @Published public var singleURLText: String = ""
    @Published public var batchURLsText: String = ""
    @Published public var statusMessage: String = "就绪"
    @Published public var previewMessage: String = "请选择一个结果进行预览"
    @Published public var previewPlayer: AVPlayer?

    public let settings: SettingsStore

    private let historyStore: HistoryStore
    private let ytDlpService: YtDlpService
    private let previewService: PreviewService
    private let coordinator: DownloadCoordinator
    private let serviceAvailable: Bool
    private var searchTask: Task<Void, Never>?
    private var previewTask: Task<Void, Never>?

    public init(
        settings: SettingsStore = SettingsStore(),
        historyStore: HistoryStore = HistoryStore(),
        ytDlpService: YtDlpService? = nil
    ) {
        self.settings = settings
        self.historyStore = historyStore

        let service = ytDlpService ?? YtDlpService()
        self.ytDlpService = service
        self.previewService = PreviewService(ytDlpService: service)
        self.coordinator = DownloadCoordinator(service: service, historyStore: historyStore, maxConcurrentDownloads: settings.concurrentDownloads)
        self.serviceAvailable = service.isAvailable
        self.statusMessage = service.isAvailable ? "就绪" : "未找到 yt-dlp，搜索/下载/预览将不可用"

        settings.onChange = { [weak self] in
            guard let self else { return }
            Task {
                await self.coordinator.updateMaxConcurrentDownloads(self.settings.concurrentDownloads)
            }
        }

        Task { [coordinator] in
            await coordinator.setStateDidChangeHandler { [weak self] in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    await self.reloadState()
                }
            }
            let restored = await coordinator.restorePersistedQueue()
            await self.reloadState()
            if restored > 0 {
                self.statusMessage = "已恢复 \(restored) 个未完成任务到队列（可继续下载）"
            }
        }
    }

    public func reloadState() async {
        queueTasks = await coordinator.snapshot()
        historyTasks = await historyStore.loadDownloadTasks(limit: nil)
        recentSearches = await historyStore.recentSearches(limit: 20)
    }

    public func searchHistory(query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            historyTasks = await historyStore.loadDownloadTasks(limit: nil)
        } else {
            historyTasks = await historyStore.searchDownloadTasks(query: trimmed)
        }
    }

    public func performSearch() {
        searchTask?.cancel()
        ytDlpService.cancelActiveSearch()

        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            statusMessage = "请输入搜索关键词"
            return
        }

        guard serviceAvailable else {
            statusMessage = "yt-dlp 未安装，无法搜索"
            return
        }

        let platform = selectedPlatform
        let proxy = settings.effectiveProxyURL()
        let service = ytDlpService

        searchTask = Task(priority: .userInitiated) { [weak self] in
            guard let self else { return }
            await self.runSearch(
                query: query,
                platform: platform,
                proxy: proxy,
                service: service
            )
        }
    }

    private func runSearch(
        query: String,
        platform: Platform,
        proxy: String?,
        service: YtDlpService
    ) async {
        defer { searchTask = nil }
        statusMessage = "正在搜索 \(platform.displayName)..."

        do {
            let results = try await Task.detached(priority: .userInitiated) {
                try service.search(
                    platform: platform,
                    query: query,
                    maxResults: 20,
                    proxy: proxy
                )
            }.value

            guard !Task.isCancelled else {
                return
            }

            searchResults = results
            selectedSearchResultDidChange()
            do {
                try await historyStore.appendSearch(platform: platform, query: query)
                recentSearches = await historyStore.recentSearches(limit: 20)
            } catch {
                statusMessage = "搜索成功，但历史保存失败: \(error.localizedDescription)"
                return
            }
            statusMessage = "找到 \(results.count) 条结果"
        } catch {
            guard !Task.isCancelled else {
                return
            }
            statusMessage = error.localizedDescription
        }
    }

    public func enqueueSingleDownload() async {
        await enqueueDownload(rawValue: singleURLText)
        singleURLText = ""
    }

    public func enqueueBatchDownloads() async {
        let urls = batchURLsText
            .split(whereSeparator: \.isNewline)
            .map(String.init)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        guard !urls.isEmpty else {
            statusMessage = "请输入至少一个有效链接"
            return
        }

        for url in urls {
            await enqueueDownload(rawValue: url)
        }

        batchURLsText = ""
        statusMessage = "已添加 \(urls.count) 个任务"
    }

    public func enqueueDownload(rawValue: String) async {
        guard serviceAvailable else {
            statusMessage = "yt-dlp 未安装，无法下载"
            return
        }

        let normalized = ytDlpService.normalizeVideoURL(rawValue)
        guard !normalized.isEmpty else {
            statusMessage = "请输入有效链接或视频 ID"
            return
        }

        let proxy = settings.effectiveProxyURL()
        let service = ytDlpService
        var videoInfo = VideoInfo(
            url: normalized,
            title: "正在获取信息...",
            platform: service.detectPlatform(from: normalized)
        )

        if let extracted = try? await Task.detached(priority: .userInitiated, operation: {
            try service.extractVideoInfo(url: normalized, proxy: proxy)
        }).value {
            videoInfo = extracted
        }

        let task = DownloadTask(videoInfo: videoInfo, options: settings.makeDownloadOptions())
        await coordinator.enqueue(task)
        await reloadState()
        statusMessage = "已加入队列：\(videoInfo.displayTitle)"
    }

    public func enqueueDownload(videoInfo: VideoInfo) async {
        let task = DownloadTask(videoInfo: videoInfo, options: settings.makeDownloadOptions())
        await coordinator.enqueue(task)
        await reloadState()
        statusMessage = "已加入队列"
    }

    public func preview(videoInfo: VideoInfo) {
        previewTask?.cancel()
        ytDlpService.cancelActiveResolve()
        previewPlayer?.pause()
        previewPlayer = nil

        guard serviceAvailable else {
            previewMessage = "yt-dlp 未安装，无法解析预览链接"
            previewPlayer = nil
            return
        }

        let service = previewService
        let url = videoInfo.url

        previewTask = Task(priority: .userInitiated) { [weak self] in
            guard let self else { return }
            await self.runPreview(url: url, service: service)
        }
    }

    private func runPreview(url: String, service: PreviewService) async {
        defer { previewTask = nil }
        previewMessage = "正在解析可播放链接..."

        do {
            let resolvedURL = try await Task.detached(priority: .userInitiated) {
                try service.resolvePlayableURL(from: url)
            }.value

            guard !Task.isCancelled else {
                return
            }

            previewPlayer = AVPlayer(url: resolvedURL)
            previewMessage = "预览就绪"
        } catch {
            guard !Task.isCancelled else {
                return
            }
            previewPlayer = nil
            previewMessage = "预览失败: \(error.localizedDescription)"
        }
    }

    public func clearPreview() {
        previewTask?.cancel()
        ytDlpService.cancelActiveResolve()
        previewPlayer?.pause()
        previewPlayer = nil
        previewMessage = "请选择一个结果进行预览"
    }

    public func cancel(task: DownloadTask) async {
        await coordinator.cancel(task.id)
        await reloadState()
    }

    public func pause(task: DownloadTask) async {
        await coordinator.pause(task.id)
        await reloadState()
    }

    public func resume(task: DownloadTask) async {
        await coordinator.resume(task.id)
        await reloadState()
    }

    public func retry(task: DownloadTask) async {
        if await coordinator.task(id: task.id) != nil {
            let ok = await coordinator.retry(task.id)
            if !ok {
                statusMessage = "无法重试该任务"
                return
            }
        } else {
            await coordinator.enqueueRestored(task)
        }
        await reloadState()
        statusMessage = "已重新排队"
    }

    public func deleteHistoryTask(id: UUID) async {
        do {
            try await historyStore.deleteDownloadTask(id: id)
            await coordinator.removeTask(id: id)
            await reloadState()
            statusMessage = "已删除历史记录"
        } catch {
            statusMessage = "删除失败: \(error.localizedDescription)"
        }
    }

    public func redownload(task: DownloadTask) async {
        let newTask = DownloadTask(
            videoInfo: task.videoInfo,
            options: settings.makeDownloadOptions()
        )
        await coordinator.enqueue(newTask)
        await reloadState()
        statusMessage = "已重新加入队列"
    }

    public func openSourceURL(for task: DownloadTask) {
        openSourceURL(task.videoInfo.url)
    }

    public func openSourceURL(_ rawValue: String) {
        let normalized = ytDlpService.normalizeVideoURL(rawValue)
        guard let url = URL(string: normalized) else {
            statusMessage = "无法打开链接"
            return
        }

        NSWorkspace.shared.open(url)
    }

    public func openDownloadDirectory() {
        let directoryURL = URL(fileURLWithPath: settings.downloadDirectory, isDirectory: true)
        try? FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true, attributes: nil)
        NSWorkspace.shared.open(directoryURL)
    }

    public func revealDownloadedFile(for task: DownloadTask) {
        let path = task.filePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else {
            openDownloadDirectory()
            return
        }

        let fileURL = URL(fileURLWithPath: path)
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: fileURL.path) {
            NSWorkspace.shared.activateFileViewerSelecting([fileURL])
            return
        }

        let directoryURL = fileURL.deletingLastPathComponent()
        if fileManager.fileExists(atPath: directoryURL.path) {
            NSWorkspace.shared.open(directoryURL)
        } else {
            openDownloadDirectory()
        }
    }

    public func search(using historyEntry: SearchHistoryEntry) {
        searchQuery = historyEntry.query
        selectedPlatform = historyEntry.platform
        performSearch()
    }

    private func selectedSearchResultDidChange() {
        previewPlayer = nil
        previewMessage = "请选择一个结果进行预览"
    }
}
