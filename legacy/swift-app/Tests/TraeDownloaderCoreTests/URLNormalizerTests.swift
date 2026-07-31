import Testing
@testable import TraeDownloaderCore

@Test
func normalizesYouTubeVideoID() {
    #expect(
        URLNormalizer.normalize("dQw4w9WgXcQ") == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    )
}

@Test
func normalizesBilibiliBVCode() {
    #expect(
        URLNormalizer.normalize("bv1xx411c7mD") == "https://www.bilibili.com/video/BV1XX411C7MD"
    )
}

@Test
func preservesFullURL() {
    let url = "https://www.bilibili.com/video/BV1XX411C7M"
    #expect(URLNormalizer.normalize(url) == url)
}
