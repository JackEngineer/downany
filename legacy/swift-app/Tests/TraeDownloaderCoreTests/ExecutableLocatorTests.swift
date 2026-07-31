import Foundation
import Testing
@testable import TraeDownloaderCore

@Test
func locateExecutableInPath() throws {
    let root = try makeTemporaryDirectory()
    let executable = root.appendingPathComponent("yt-dlp")
    guard let data = "#!/bin/sh\nexit 0\n".data(using: .utf8) else {
        #expect(Bool(false))
        return
    }
    try data.write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

    let located = ExecutableLocator.locate(
        "yt-dlp",
        environment: ["PATH": root.path],
        fileManager: FileManager.default,
        bundle: Bundle.main
    )

    #expect(located?.path == executable.path)
}

@Test
func locateExecutableInsideBundleResources() throws {
    let root = try makeTemporaryDirectory()
    let bundleURL = root.appendingPathComponent("TraeDownloader.app", isDirectory: true)
    let contentsURL = bundleURL.appendingPathComponent("Contents", isDirectory: true)
    let resourcesURL = contentsURL.appendingPathComponent("Resources", isDirectory: true)

    try FileManager.default.createDirectory(at: resourcesURL, withIntermediateDirectories: true, attributes: nil)

    let infoPlist = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>CFBundleExecutable</key>
        <string>TraeDownloaderApp</string>
        <key>CFBundleIdentifier</key>
        <string>com.jacklee.traedownloader.swift.tests</string>
        <key>CFBundlePackageType</key>
        <string>APPL</string>
    </dict>
    </plist>
    """
    guard let infoPlistData = infoPlist.data(using: .utf8) else {
        Issue.record("Failed to encode Info.plist")
        return
    }
    try infoPlistData.write(to: contentsURL.appendingPathComponent("Info.plist"))

    let executable = resourcesURL.appendingPathComponent("yt-dlp")
    guard let data = "#!/bin/sh\nexit 0\n".data(using: .utf8) else {
        #expect(Bool(false))
        return
    }
    try data.write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

    guard let bundle = Bundle(path: bundleURL.path) else {
        Issue.record("Failed to load bundle at \(bundleURL.path)")
        return
    }

    let located = ExecutableLocator.locate(
        "yt-dlp",
        environment: [:],
        fileManager: FileManager.default,
        bundle: bundle
    )

    #expect(located?.path == executable.path)
}
