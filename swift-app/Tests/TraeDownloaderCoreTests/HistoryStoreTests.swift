import Foundation
import Testing
@testable import TraeDownloaderCore

@Test
func downloadTasksRoundTrip() async throws {
    let root = try makeTemporaryDirectory()
    let store = HistoryStore(baseDirectory: root)

    let task = DownloadTask(
        videoInfo: VideoInfo(
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            title: "Never Gonna Give You Up",
            uploader: "Rick Astley",
            platform: .youtube
        ),
        options: DownloadOptions(outputPath: "/tmp/trae"),
        status: .completed,
        progress: 100,
        filePath: "/tmp/trae/Never Gonna Give You Up.mp4",
        createdAt: Date(timeIntervalSince1970: 1_700_000_000),
        startedAt: Date(timeIntervalSince1970: 1_700_000_100),
        completedAt: Date(timeIntervalSince1970: 1_700_000_200)
    )

    try await store.upsertDownloadTask(task)
    let loaded = await store.loadDownloadTasks(limit: nil)

    #expect(loaded.count == 1)
    #expect(loaded.first?.videoInfo.platform == .youtube)
    #expect(loaded.first?.filePath == "/tmp/trae/Never Gonna Give You Up.mp4")
}

@Test
func activeQueueRoundTrip() async throws {
    let root = try makeTemporaryDirectory()
    let store = HistoryStore(baseDirectory: root)

    let task = DownloadTask(
        videoInfo: VideoInfo(url: "https://example.com/a", title: "queued", platform: .youtube),
        status: .pending
    )
    try await store.saveActiveQueue([task])
    let loaded = await store.loadActiveQueue()
    #expect(loaded.count == 1)
    #expect(loaded.first?.id == task.id)
    #expect(loaded.first?.status == .pending)

    try await store.clearActiveQueue()
    #expect(await store.loadActiveQueue().isEmpty)
}

@Test
func searchHistoryIsStoredNewestFirst() async throws {
    let root = try makeTemporaryDirectory()
    let store = HistoryStore(baseDirectory: root)

    try await store.appendSearch(platform: .bilibili, query: "swift")
    try await store.appendSearch(platform: .youtube, query: "swift ui")

    let recent = await store.recentSearches(limit: 2)
    #expect(recent.count == 2)
    #expect(recent.first?.query == "swift ui")
    #expect(recent.last?.platform == .bilibili)
}
