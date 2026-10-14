import Foundation
import LakeUpdateCore

func testDesktopProfiles() {
    let release = DesktopProfile(bundleIdentifier: "com.cleanlakes.lake.desktop")
    let dev = DesktopProfile(bundleIdentifier: "com.cleanlakes.lake.desktop.dev")
    let inherited = ["LAKE_HOME": "/release", "LAKE_WEB_DATA_DIR": "/release/web-agent"]
    let a = release.directories(userHome: "/user", environment: inherited, arguments: [])
    let b = dev.directories(userHome: "/user", environment: inherited, arguments: [])
    precondition(a.home.path == "/release" && a.data.path == "/release/web-agent")
    // Inherited production environment variables must never make Dev attach to the release backend.
    precondition(b.home.path == "/user/.lake-dev" && b.data.path == "/user/.lake-dev/web-agent")
    precondition(release.allowsReleaseUpdates && !dev.allowsReleaseUpdates)
    let configured = dev.directories(userHome: "/user", environment: ["LAKE_DEV_HOME": "/test"], arguments: [])
    precondition(configured.home.path == "/test" && configured.data.path == "/test/web-agent")
    let explicit = dev.directories(userHome: "/user", environment: [:], arguments: ["--lake-home", "/isolated", "--lake-data", "/data"])
    precondition(explicit.home.path == "/isolated" && explicit.data.path == "/data")
    print("Passed desktop profile isolation: release/Dev directories, environment and update policy")
}
