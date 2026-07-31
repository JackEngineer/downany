import Combine
import Foundation

@MainActor
public final class SettingsStore: ObservableObject {
    public struct Payload: Codable, Sendable {
        public var downloadDirectory: String
        public var concurrentDownloads: Int
        public var speedLimit: Int
        public var proxyEnabled: Bool
        public var proxyURL: String
        public var defaultQuality: DownloadQuality
        public var downloadSubtitles: Bool
        public var themeMode: ThemeMode

        public init(
            downloadDirectory: String = DownloadOptions.defaultDownloadDirectory(),
            concurrentDownloads: Int = 3,
            speedLimit: Int = 0,
            proxyEnabled: Bool = false,
            proxyURL: String = "",
            defaultQuality: DownloadQuality = .best,
            downloadSubtitles: Bool = false,
            themeMode: ThemeMode = .system
        ) {
            self.downloadDirectory = downloadDirectory
            self.concurrentDownloads = concurrentDownloads
            self.speedLimit = speedLimit
            self.proxyEnabled = proxyEnabled
            self.proxyURL = proxyURL
            self.defaultQuality = defaultQuality
            self.downloadSubtitles = downloadSubtitles
            self.themeMode = themeMode
        }
    }

    public var onChange: (() -> Void)?

    @Published public var downloadDirectory: String {
        didSet { persist() }
    }
    @Published public var concurrentDownloads: Int {
        didSet { persist(); onChange?() }
    }
    @Published public var speedLimit: Int {
        didSet { persist() }
    }
    @Published public var proxyEnabled: Bool {
        didSet { persist() }
    }
    @Published public var proxyURL: String {
        didSet { persist() }
    }
    @Published public var defaultQuality: DownloadQuality {
        didSet { persist() }
    }
    @Published public var downloadSubtitles: Bool {
        didSet { persist() }
    }
    @Published public var themeMode: ThemeMode {
        didSet { persist() }
    }

    @Published public var lastPersistError: String = ""

    private let fileURL: URL

    public init(baseDirectory: URL? = nil, fileManager: FileManager = .default) {
        let rootDirectory = baseDirectory ?? SettingsStore.defaultRootDirectory(fileManager: fileManager)
        self.fileURL = rootDirectory.appendingPathComponent("settings.json")

        let payload = SettingsStore.loadPayload(from: fileURL) ?? Payload()
        self.downloadDirectory = payload.downloadDirectory
        self.concurrentDownloads = payload.concurrentDownloads
        self.speedLimit = payload.speedLimit
        self.proxyEnabled = payload.proxyEnabled
        self.proxyURL = payload.proxyURL
        self.defaultQuality = payload.defaultQuality
        self.downloadSubtitles = payload.downloadSubtitles
        self.themeMode = payload.themeMode

        persist()
    }

    public func effectiveProxyURL() -> String? {
        guard proxyEnabled, !proxyURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return proxyURL
    }

    public func makeDownloadOptions() -> DownloadOptions {
        DownloadOptions(
            quality: defaultQuality,
            downloadSubtitles: downloadSubtitles,
            outputPath: downloadDirectory,
            speedLimit: speedLimit > 0 ? speedLimit : nil,
            proxy: effectiveProxyURL()
        )
    }

    private func persist() {
        do {
            try Self.ensureDirectoryExists(fileURL.deletingLastPathComponent())
            let payload = Payload(
                downloadDirectory: downloadDirectory,
                concurrentDownloads: concurrentDownloads,
                speedLimit: speedLimit,
                proxyEnabled: proxyEnabled,
                proxyURL: proxyURL,
                defaultQuality: defaultQuality,
                downloadSubtitles: downloadSubtitles,
                themeMode: themeMode
            )
            let data = try Self.encoder.encode(payload)
            try data.write(to: fileURL, options: [.atomic])
            lastPersistError = ""
        } catch {
            lastPersistError = error.localizedDescription
        }
    }

    private static func loadPayload(from fileURL: URL) -> Payload? {
        guard let data = try? Data(contentsOf: fileURL) else {
            return nil
        }
        return try? decoder.decode(Payload.self, from: data)
    }

    private static func defaultRootDirectory(fileManager: FileManager) -> URL {
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.homeDirectoryForCurrentUser
        return appSupport.appendingPathComponent("TraeDownloaderSwift", isDirectory: true)
    }

    private static func ensureDirectoryExists(_ directoryURL: URL) throws {
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true, attributes: nil)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        JSONDecoder()
    }()
}
