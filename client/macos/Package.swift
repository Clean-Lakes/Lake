// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LakeMacOS", platforms: [.macOS(.v13)],
    products: [.executable(name: "LakeDesktop", targets: ["LakeDesktop"])],
    targets: [
        .target(name: "LakeUpdateCore"),
        .executableTarget(name: "LakeDesktop", dependencies: ["LakeUpdateCore"]),
        // Standalone assertions also run with Command Line Tools, which do not ship XCTest.
        .executableTarget(name: "LakeUpdateTests", dependencies: ["LakeUpdateCore"], path: "Tests/LakeUpdateCoreTests")
    ]
)
