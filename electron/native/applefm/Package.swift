// swift-tools-version: 6.0
import PackageDescription

// Needs the macOS 26 SDK (which ships the FoundationModels framework) — it comes
// with Xcode 26+ or the macOS 26 (Tahoe) command line tools. The deployment
// target is intentionally older than macOS 26: every FoundationModels API use in
// main.swift is guarded by #available(macOS 26, *), and build.sh refuses to build
// on older macOS anyway. This keeps the manifest parseable by Swift toolchains
// older than 6.2 (which is where `.macOS(.v26)` was introduced).
let package = Package(
    name: "applefm-bridge",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "applefm-bridge",
            path: "Sources/applefm-bridge"
        )
    ]
)
