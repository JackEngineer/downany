import Foundation

public enum ExecutableLocator {
    public static func locate(
        _ executableName: String,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default,
        bundle: Bundle = .main
    ) -> URL? {
        let candidateURLs: [URL?] = [
            bundle.resourceURL?.appendingPathComponent(executableName),
            bundle.bundleURL.appendingPathComponent("Contents/Resources").appendingPathComponent(executableName),
            bundle.bundleURL.appendingPathComponent("Contents/MacOS").appendingPathComponent(executableName),
            bundle.executableURL?.deletingLastPathComponent().appendingPathComponent(executableName),
            currentDirectoryCandidates(executableName: executableName, fileManager: fileManager)
        ]

        for candidate in candidateURLs.compactMap({ $0 }) {
            if fileManager.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }

        if let path = environment["PATH"] {
            for directory in path.split(separator: ":") {
                let candidate = URL(fileURLWithPath: String(directory)).appendingPathComponent(executableName)
                if fileManager.isExecutableFile(atPath: candidate.path) {
                    return candidate
                }
            }
        }

        return nil
    }

    private static func currentDirectoryCandidates(executableName: String, fileManager: FileManager) -> URL? {
        let current = URL(fileURLWithPath: fileManager.currentDirectoryPath)
        let ancestors = [
            current,
            current.deletingLastPathComponent(),
            current.deletingLastPathComponent().deletingLastPathComponent()
        ]

        for ancestor in ancestors {
            let candidate = ancestor.appendingPathComponent("bin").appendingPathComponent(executableName)
            if fileManager.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }

        return nil
    }
}
