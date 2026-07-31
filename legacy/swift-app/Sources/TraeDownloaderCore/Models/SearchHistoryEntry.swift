import Foundation

public struct SearchHistoryEntry: Codable, Hashable, Identifiable, Sendable {
    public var id: Int
    public var platform: Platform
    public var query: String
    public var searchedAt: Date

    public init(id: Int, platform: Platform, query: String, searchedAt: Date = Date()) {
        self.id = id
        self.platform = platform
        self.query = query
        self.searchedAt = searchedAt
    }
}
