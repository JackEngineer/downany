import Testing
@testable import TraeDownloaderCore

@Test
func detectsYouTubeFromVideoID() {
    #expect(PlatformDetector.detect(from: "dQw4w9WgXcQ") == .youtube)
}

@Test
func detectsBilibiliFromURL() {
    #expect(
        PlatformDetector.detect(from: "https://www.bilibili.com/video/BV1XX411C7M") == .bilibili
    )
}

@Test
func detectsTwitterFromXDomain() {
    #expect(PlatformDetector.detect(from: "https://x.com/example/status/1") == .twitter)
}
