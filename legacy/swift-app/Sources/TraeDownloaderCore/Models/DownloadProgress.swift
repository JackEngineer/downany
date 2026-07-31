import Foundation

public struct DownloadProgress: Hashable, Sendable {
    public var percent: Double
    public var speed: String
    public var eta: String
    public var rawLine: String

    public init(percent: Double, speed: String, eta: String, rawLine: String) {
        self.percent = percent
        self.speed = speed
        self.eta = eta
        self.rawLine = rawLine
    }
}
