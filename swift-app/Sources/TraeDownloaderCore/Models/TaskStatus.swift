import Foundation

public enum TaskStatus: String, Codable, CaseIterable, Identifiable, Sendable {
    case pending
    case downloading
    case paused
    case completed
    case failed
    case cancelled

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .pending:
            return "等待中"
        case .downloading:
            return "下载中"
        case .paused:
            return "已暂停"
        case .completed:
            return "已完成"
        case .failed:
            return "失败"
        case .cancelled:
            return "已取消"
        }
    }
}
