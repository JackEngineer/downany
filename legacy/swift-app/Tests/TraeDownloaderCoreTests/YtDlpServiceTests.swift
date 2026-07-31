import Foundation
import Testing
@testable import TraeDownloaderCore

@Test
func buildsDownloadArgumentsWithNormalizationAndTools() throws {
    let service = YtDlpService(
        ytDlpExecutable: URL(fileURLWithPath: "/usr/local/bin/yt-dlp"),
        ffmpegExecutable: URL(fileURLWithPath: "/usr/local/bin/ffmpeg")
    )
    let task = DownloadTask(
        videoInfo: VideoInfo(
            url: "dQw4w9WgXcQ",
            title: "Test Video",
            platform: .youtube
        ),
        options: DownloadOptions(
            formatID: nil,
            quality: .p720,
            downloadSubtitles: true,
            outputPath: "/tmp/trae",
            speedLimit: 2048,
            proxy: "http://127.0.0.1:7890"
        )
    )

    let arguments = try service.makeDownloadArguments(for: task)
    #expect(arguments.contains("--write-subs"))
    #expect(arguments.contains("--write-auto-subs"))
    #expect(arguments.contains("--limit-rate"))
    #expect(arguments.contains("2048"))
    #expect(arguments.contains("--proxy"))
    #expect(arguments.contains("http://127.0.0.1:7890"))
    #expect(arguments.contains("--ffmpeg-location"))
    #expect(arguments.contains("/usr/local/bin/ffmpeg"))
    #expect(arguments.last == "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
}

@Test
func buildsSearchArguments() throws {
    let service = YtDlpService(ytDlpExecutable: URL(fileURLWithPath: "/usr/local/bin/yt-dlp"))
    let arguments = try service.makeSearchArguments(platform: .youtube, query: "lofi", maxResults: 12, proxy: nil)
    #expect(arguments.last == "ytsearch12:lofi")
    #expect(arguments.contains("--dump-single-json"))
}

@Test
func buildsResolveArguments() throws {
    let service = YtDlpService(ytDlpExecutable: URL(fileURLWithPath: "/usr/local/bin/yt-dlp"))
    let arguments = service.makeResolveArguments(for: "BV1xx411c7mD")
    #expect(arguments.last == "https://www.bilibili.com/video/BV1XX411C7MD")
}
