// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FigmaMCP",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "FigmaMCP", targets: ["FigmaMCP"])],
    targets: [
        .target(name: "FigmaMCPKit"),
        .executableTarget(name: "FigmaMCP", dependencies: ["FigmaMCPKit"]),
        .testTarget(name: "FigmaMCPKitTests", dependencies: ["FigmaMCPKit"]),
    ]
)
