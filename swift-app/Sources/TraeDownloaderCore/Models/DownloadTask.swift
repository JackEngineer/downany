import Foundation

public struct DownloadTask: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var videoInfo: VideoInfo
    public var options: DownloadOptions
    public var status: TaskStatus
    public var progress: Double
    public var speed: String
    public var eta: String
    public var filePath: String
    public var errorMessage: String
    public var createdAt: Date
    public var startedAt: Date?
    public var completedAt: Date?

    public init(
        id: UUID = UUID(),
        videoInfo: VideoInfo,
        options: DownloadOptions = DownloadOptions(),
        status: TaskStatus = .pending,
        progress: Double = 0,
        speed: String = "0 B/s",
        eta: String = "N/A",
        filePath: String = "",
        errorMessage: String = "",
        createdAt: Date = Date(),
        startedAt: Date? = nil,
        completedAt: Date? = nil
    ) {
        self.id = id
        self.videoInfo = videoInfo
        self.options = options
        self.status = status
        self.progress = progress
        self.speed = speed
        self.eta = eta
        self.filePath = filePath
        self.errorMessage = errorMessage
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.completedAt = completedAt
    }

    public var displayTitle: String {
        videoInfo.displayTitle
    }
}
