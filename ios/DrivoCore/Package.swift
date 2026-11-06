// swift-tools-version:5.9
import PackageDescription

// Platform-neutral tracking rules, the same as android/core. No UIKit or
// Core Location here, so it builds and tests anywhere Swift runs.
let package = Package(
    name: "DrivoCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "DrivoCore", targets: ["DrivoCore"])],
    targets: [
        .target(name: "DrivoCore"),
        .testTarget(name: "DrivoCoreTests", dependencies: ["DrivoCore"]),
    ]
)
