// swift-tools-version: 6.0
import PackageDescription

// Requires Xcode 26+ (Swift 6.2 toolchain) so that `.macOS(.v26)` — macOS Tahoe —
// is a known platform version, and the macOS 26 SDK ships FoundationModels.
let package = Package(
    name: "applefm-bridge",
    platforms: [
        .macOS(.v26)
    ],
    targets: [
        .executableTarget(
            name: "applefm-bridge",
            path: "Sources/applefm-bridge"
        )
    ]
)
