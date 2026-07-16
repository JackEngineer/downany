import Foundation

public struct VideoInfo: Codable, Hashable, Identifiable, Sendable {
    public var id: String { url }

    public var url: String
    public var title: String
    public var duration: Int
    public var thumbnailURL: String
    public var uploader: String
    public var platform: Platform
    public var fileSize: Int
    public var formats: [VideoFormat]

    public init(
        url: String,
        title: String = "",
        duration: Int = 0,
        thumbnailURL: String = "",
        uploader: String = "",
        platform: Platform = .unknown,
        fileSize: Int = 0,
        formats: [VideoFormat] = []
    ) {
        self.url = url
        self.title = title
        self.duration = duration
        self.thumbnailURL = thumbnailURL
        self.uploader = uploader
        self.platform = platform
        self.fileSize = fileSize
        self.formats = formats
    }

    public var displayTitle: String {
        title.isEmpty ? "正在获取信息..." : title
    }
}
