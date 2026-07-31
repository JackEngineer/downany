import Foundation

public final class PreviewService: @unchecked Sendable {
    private let ytDlpService: YtDlpService

    public init(ytDlpService: YtDlpService) {
        self.ytDlpService = ytDlpService
    }

    public func resolvePlayableURL(from sourceURL: String) throws -> URL {
        try ytDlpService.resolvePlayableURL(for: sourceURL)
    }
}
