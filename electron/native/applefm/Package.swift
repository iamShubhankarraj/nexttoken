// swift-tools-version: 6.2
import PackageDescription

// Needs the macOS 26 SDK (which ships the FoundationModels framework) — it comes
// with Xcode 26+ or the macOS 26 (Tahoe) command line tools. The deployment
// target is macOS 26: v0.6.0 used .v13 so the manifest would parse on older
// toolchains, but the @Generable-free rewrite targets Swift 6.2+ anyway and
// every FoundationModels API use requires macOS 26 regardless.
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
