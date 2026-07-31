// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "TraeDownloaderSwift",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "TraeDownloaderCore",
            targets: ["TraeDownloaderCore"]
        ),
        .executable(
            name: "TraeDownloaderApp",
            targets: ["TraeDownloaderApp"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-testing.git", branch: "release/6.2.1")
    ],
    targets: [
        .target(
            name: "TraeDownloaderCore"
        ),
        .executableTarget(
            name: "TraeDownloaderApp",
            dependencies: ["TraeDownloaderCore"]
        ),
        .testTarget(
            name: "TraeDownloaderCoreTests",
            dependencies: [
                "TraeDownloaderCore",
                .product(name: "Testing", package: "swift-testing")
            ]
        ),
    ]
)
