import Foundation

public struct VideoFormat: Codable, Hashable, Sendable {
    public var formatID: String
    public var ext: String?
    public var width: Int?
    public var height: Int?
    public var fps: Double?
    public var tbr: Double?
    public var note: String?

    public init(
        formatID: String,
        ext: String? = nil,
        width: Int? = nil,
        height: Int? = nil,
        fps: Double? = nil,
        tbr: Double? = nil,
        note: String? = nil
    ) {
        self.formatID = formatID
        self.ext = ext
        self.width = width
        self.height = height
        self.fps = fps
        self.tbr = tbr
        self.note = note
    }
}
