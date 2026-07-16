import Foundation
import Testing
@testable import TraeDownloaderCore

@MainActor
@Test
func settingsPersistAndReload() throws {
    let root = try makeTemporaryDirectory()
    let store = SettingsStore(baseDirectory: root)

    store.downloadDirectory = "/tmp/custom-downloads"
    store.concurrentDownloads = 5
    store.speedLimit = 1024
    store.proxyEnabled = true
    store.proxyURL = "http://127.0.0.1:7890"
    store.defaultQuality = .p720
    store.downloadSubtitles = true
    store.themeMode = .dark

    let reloaded = SettingsStore(baseDirectory: root)
    #expect(reloaded.downloadDirectory == "/tmp/custom-downloads")
    #expect(reloaded.concurrentDownloads == 5)
    #expect(reloaded.speedLimit == 1024)
    #expect(reloaded.proxyEnabled == true)
    #expect(reloaded.proxyURL == "http://127.0.0.1:7890")
    #expect(reloaded.defaultQuality == .p720)
    #expect(reloaded.downloadSubtitles == true)
    #expect(reloaded.themeMode == .dark)
}
