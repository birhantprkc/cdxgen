// swift-tools-version:5.9
import PackageDescription

// Evidence fixture: swift-argument-parser is used by the executable, while
// swift-algorithms (and the swift-numerics package it pulls in) is only used
// by the tests
let package = Package(
    name: "evinse-demo",
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.5.0"),
        .package(url: "https://github.com/apple/swift-algorithms", from: "1.2.0"),
    ],
    targets: [
        .executableTarget(
            name: "evinse-demo",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ]
        ),
        .testTarget(
            name: "evinse-demoTests",
            dependencies: [
                "evinse-demo",
                .product(name: "Algorithms", package: "swift-algorithms"),
            ]
        ),
    ]
)
