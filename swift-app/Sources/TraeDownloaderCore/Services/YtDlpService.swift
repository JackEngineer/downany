import Foundation

public struct DownloadOutcome: Sendable {
    public var exitCode: Int32
    public var filePath: String?
    public var stdout: String
    public var stderr: String

    public init(exitCode: Int32, filePath: String?, stdout: String, stderr: String) {
        self.exitCode = exitCode
        self.filePath = filePath
        self.stdout = stdout
        self.stderr = stderr
    }
}

public final class YtDlpService: @unchecked Sendable {
    public enum ServiceError: Error, LocalizedError {
        case executableNotFound(String)
        case unsupportedPlatform
        case invalidSearchResult
        case processFailed(Int32, String)

        public var errorDescription: String? {
            switch self {
            case let .executableNotFound(name):
                return "\(name) 未找到"
            case .unsupportedPlatform:
                return "当前平台不支持该操作"
            case .invalidSearchResult:
                return "无法解析 yt-dlp 搜索结果"
            case let .processFailed(code, message):
                return "命令执行失败 (\(code)): \(message)"
            }
        }
    }

    private struct SearchResponse: Codable {
        var entries: [SearchEntry]?
    }

    private struct SearchEntry: Codable {
        var id: String?
        var title: String?
        var duration: Int?
        var thumbnail: String?
        var uploader: String?
        var url: String?
        var webpageURL: String?

        enum CodingKeys: String, CodingKey {
            case id
            case title
            case duration
            case thumbnail
            case uploader
            case url
            case webpageURL = "webpage_url"
        }
    }

    private let runner: ProcessRunner
    private let ytDlpExecutable: URL?
    private let ffmpegExecutable: URL?
    private let fileManager: FileManager
    private let activeExecutionLock = NSLock()
    private var activeSearchExecution: ProcessExecution?
    private var activeResolveExecution: ProcessExecution?
    private var activeExtractExecution: ProcessExecution?

    public var isAvailable: Bool {
        ytDlpExecutable != nil
    }

    public init(
        runner: ProcessRunner = ProcessRunner(),
        ytDlpExecutable: URL? = nil,
        ffmpegExecutable: URL? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default,
        bundle: Bundle = .main
    ) {
        self.runner = runner
        self.fileManager = fileManager

        if let ytDlpExecutable {
            self.ytDlpExecutable = ytDlpExecutable
        } else if let located = ExecutableLocator.locate("yt-dlp", environment: environment, fileManager: fileManager, bundle: bundle) {
            self.ytDlpExecutable = located
        } else {
            self.ytDlpExecutable = nil
        }

        if let ffmpegExecutable {
            self.ffmpegExecutable = ffmpegExecutable
        } else {
            self.ffmpegExecutable = ExecutableLocator.locate("ffmpeg", environment: environment, fileManager: fileManager, bundle: bundle)
        }
    }

    public func normalizeVideoURL(_ rawValue: String) -> String {
        URLNormalizer.normalize(rawValue)
    }

    public func detectPlatform(from rawValue: String) -> Platform {
        PlatformDetector.detect(from: rawValue)
    }

    public func makeSearchArguments(
        platform: Platform,
        query: String,
        maxResults: Int = 20,
        proxy: String? = nil
    ) throws -> [String] {
        guard let prefix = platform.searchPrefix else {
            throw ServiceError.unsupportedPlatform
        }

        var arguments = [
            "--dump-single-json",
            "--flat-playlist",
            "--quiet",
            "--no-warnings",
            "--no-color",
            "--no-playlist",
            "\(prefix)\(maxResults):\(query)"
        ]

        if let proxy, !proxy.isEmpty {
            arguments.insert(contentsOf: ["--proxy", proxy], at: 0)
        }

        return arguments
    }

    private enum AuxiliarySlot {
        case search
        case resolve
        case extract
    }

    public func cancelActiveSearch() {
        activeExecutionLock.lock()
        activeSearchExecution?.cancel()
        activeExecutionLock.unlock()
    }

    public func cancelActiveResolve() {
        activeExecutionLock.lock()
        activeResolveExecution?.cancel()
        activeExecutionLock.unlock()
    }

    public func cancelActiveExtract() {
        activeExecutionLock.lock()
        activeExtractExecution?.cancel()
        activeExecutionLock.unlock()
    }

    public func cancelAllAuxiliaryProcesses() {
        activeExecutionLock.lock()
        activeSearchExecution?.cancel()
        activeResolveExecution?.cancel()
        activeExtractExecution?.cancel()
        activeExecutionLock.unlock()
    }

    private func setActiveExecution(_ execution: ProcessExecution?, for slot: AuxiliarySlot) {
        switch slot {
        case .search:
            activeSearchExecution = execution
        case .resolve:
            activeResolveExecution = execution
        case .extract:
            activeExtractExecution = execution
        }
    }

    private func activeExecution(for slot: AuxiliarySlot) -> ProcessExecution? {
        switch slot {
        case .search:
            return activeSearchExecution
        case .resolve:
            return activeResolveExecution
        case .extract:
            return activeExtractExecution
        }
    }

    private func runTracked(
        slot: AuxiliarySlot,
        executableURL: URL,
        arguments: [String]
    ) throws -> ProcessResult {
        let execution = runner.makeExecution(
            executableURL: executableURL,
            arguments: arguments,
            currentDirectoryURL: URL(fileURLWithPath: fileManager.currentDirectoryPath)
        )
        activeExecutionLock.lock()
        setActiveExecution(execution, for: slot)
        activeExecutionLock.unlock()
        defer {
            activeExecutionLock.lock()
            if activeExecution(for: slot) === execution {
                setActiveExecution(nil, for: slot)
            }
            activeExecutionLock.unlock()
        }
        try execution.start()
        return execution.waitUntilExit()
    }

    public func search(
        platform: Platform,
        query: String,
        maxResults: Int = 20,
        proxy: String? = nil
    ) throws -> [VideoInfo] {
        guard let ytDlpExecutable else {
            throw ServiceError.executableNotFound("yt-dlp")
        }
        let arguments = try makeSearchArguments(platform: platform, query: query, maxResults: maxResults, proxy: proxy)
        let result = try runTracked(
            slot: .search,
            executableURL: ytDlpExecutable,
            arguments: arguments
        )

        guard result.exitCode == 0 else {
            throw ServiceError.processFailed(result.exitCode, result.stderr.isEmpty ? result.stdout : result.stderr)
        }

        let data = Data(result.stdout.utf8)
        let decoder = JSONDecoder()
        let response = try decoder.decode(SearchResponse.self, from: data)
        let entries = response.entries ?? []

        let videos = entries.compactMap { entry -> VideoInfo? in
            let normalizedURL = entry.url ?? entry.webpageURL ?? ""
            guard !normalizedURL.isEmpty || entry.id != nil else {
                return nil
            }

            let resolvedURL = normalizedURL.isEmpty ? entry.id ?? "" : normalizedURL
            let thumbnailURL = entry.thumbnail ?? fallbackThumbnail(for: platform, entryID: entry.id)
            return VideoInfo(
                url: resolvedURL,
                title: entry.title ?? "Unknown",
                duration: entry.duration ?? 0,
                thumbnailURL: thumbnailURL,
                uploader: entry.uploader ?? "Unknown",
                platform: platform
            )
        }

        if videos.isEmpty && !entries.isEmpty {
            throw ServiceError.invalidSearchResult
        }

        return videos
    }

    public func makeDownloadArguments(
        for task: DownloadTask
    ) throws -> [String] {
        let normalizedURL = normalizeVideoURL(task.videoInfo.url)
        var arguments: [String] = [
            "--newline",
            "--no-color",
            "--noplaylist",
            "--print",
            "after_move:filepath",
            "-o",
            "\(task.options.outputPath)/%(title)s.%(ext)s"
        ]

        if let formatID = task.options.formatID, !formatID.isEmpty {
            arguments.insert(contentsOf: ["-f", formatID], at: 0)
        } else {
            arguments.insert(contentsOf: ["-f", task.options.quality.ytDlpFormat], at: 0)
        }

        if let proxy = task.options.proxy, !proxy.isEmpty {
            arguments.insert(contentsOf: ["--proxy", proxy], at: 0)
        }

        if let speedLimit = task.options.speedLimit, speedLimit > 0 {
            arguments.insert(contentsOf: ["--limit-rate", "\(speedLimit)"], at: 0)
        }

        if task.options.downloadSubtitles {
            arguments.insert(contentsOf: ["--write-subs", "--write-auto-subs"], at: 0)
        }

        if let ffmpegExecutable {
            arguments.insert(contentsOf: ["--ffmpeg-location", ffmpegExecutable.path], at: 0)
        }

        arguments.append(normalizedURL)
        return arguments
    }

    public func makeResolveArguments(for rawValue: String) -> [String] {
        [
            "-g",
            "--no-playlist",
            normalizeVideoURL(rawValue)
        ]
    }

    public func resolvePlayableURL(for rawValue: String) throws -> URL {
        guard let ytDlpExecutable else {
            throw ServiceError.executableNotFound("yt-dlp")
        }
        let result = try runTracked(
            slot: .resolve,
            executableURL: ytDlpExecutable,
            arguments: makeResolveArguments(for: rawValue)
        )

        guard result.exitCode == 0 else {
            throw ServiceError.processFailed(result.exitCode, result.stderr.isEmpty ? result.stdout : result.stderr)
        }

        let urlString = result.stdout
            .split(whereSeparator: \.isNewline)
            .map(String.init)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })

        guard let urlString, let url = URL(string: urlString) else {
            throw ServiceError.invalidSearchResult
        }

        return url
    }

    public func makeDownloadExecution(
        for task: DownloadTask,
        progressHandler: @escaping @Sendable (DownloadProgress) -> Void
    ) throws -> ProcessExecution {
        guard let ytDlpExecutable else {
            throw ServiceError.executableNotFound("yt-dlp")
        }

        let arguments = try makeDownloadArguments(for: task)
        let execution = runner.makeExecution(
            executableURL: ytDlpExecutable,
            arguments: arguments,
            currentDirectoryURL: URL(fileURLWithPath: fileManager.currentDirectoryPath)
        )

        execution.onLine = { (stream: ProcessStreamKind, line: String) in
            switch stream {
            case .stdout:
                break
            case .stderr:
                if let progress = Self.parseProgress(from: line) {
                    progressHandler(progress)
                }
            }
        }

        return execution
    }

    public func parseDownloadOutputPath(from stdout: String) -> String? {
        stdout
            .split(whereSeparator: \.isNewline)
            .map(String.init)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .last(where: { !$0.isEmpty })
    }

    private func fallbackThumbnail(for platform: Platform, entryID: String?) -> String {
        switch platform {
        case .youtube:
            guard let entryID, !entryID.isEmpty else { return "" }
            return "https://i.ytimg.com/vi/\(entryID)/hqdefault.jpg"
        default:
            return ""
        }
    }

    public func extractVideoInfo(url: String, proxy: String? = nil) throws -> VideoInfo? {
        guard let ytDlpExecutable else {
            throw ServiceError.executableNotFound("yt-dlp")
        }

        var arguments = [
            "--dump-single-json",
            "--quiet",
            "--no-warnings",
            "--no-color",
            "--no-playlist",
            url
        ]
        if let proxy, !proxy.isEmpty {
            arguments.insert(contentsOf: ["--proxy", proxy], at: 0)
        }

        let result = try runTracked(
            slot: .extract,
            executableURL: ytDlpExecutable,
            arguments: arguments
        )
        guard result.exitCode == 0 else {
            return nil
        }

        struct InfoDump: Codable {
            var title: String?
            var duration: Int?
            var thumbnail: String?
            var uploader: String?
            var webpageURL: String?
            var id: String?

            enum CodingKeys: String, CodingKey {
                case title, duration, thumbnail, uploader, id
                case webpageURL = "webpage_url"
            }
        }

        guard let data = result.stdout.data(using: .utf8),
              let dump = try? JSONDecoder().decode(InfoDump.self, from: data) else {
            return nil
        }

        let platform = detectPlatform(from: url)
        return VideoInfo(
            url: dump.webpageURL ?? url,
            title: dump.title ?? "",
            duration: dump.duration ?? 0,
            thumbnailURL: dump.thumbnail ?? fallbackThumbnail(for: platform, entryID: dump.id),
            uploader: dump.uploader ?? "",
            platform: platform
        )
    }

    private static func parseProgress(from line: String) -> DownloadProgress? {
        let cleanedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanedLine.contains("[download]") else {
            return nil
        }

        // 宽松匹配：有百分号即可；速度与 ETA 可选
        let patterns = [
            ##"\[download\]\s+([0-9.]+)%.*?at\s+(\S+).*?ETA\s+(\S+)"##,
            ##"\[download\]\s+([0-9.]+)%.*?at\s+(\S+)"##,
            ##"\[download\]\s+([0-9.]+)%"##
        ]

        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern) else {
                continue
            }
            let range = NSRange(cleanedLine.startIndex..<cleanedLine.endIndex, in: cleanedLine)
            guard let match = regex.firstMatch(in: cleanedLine, options: [], range: range),
                  match.numberOfRanges >= 2,
                  let percentRange = Range(match.range(at: 1), in: cleanedLine) else {
                continue
            }

            let percent = Double(cleanedLine[percentRange]) ?? 0
            var speed = "—"
            var eta = "—"
            if match.numberOfRanges >= 3, let speedRange = Range(match.range(at: 2), in: cleanedLine) {
                speed = String(cleanedLine[speedRange])
            }
            if match.numberOfRanges >= 4, let etaRange = Range(match.range(at: 3), in: cleanedLine) {
                eta = String(cleanedLine[etaRange])
            }
            return DownloadProgress(percent: percent, speed: speed, eta: eta, rawLine: cleanedLine)
        }
        return nil
    }

    /// 供测试与调试使用。
    public static func parseProgressLine(_ line: String) -> DownloadProgress? {
        parseProgress(from: line)
    }
}
