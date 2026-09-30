import Algorithms
import XCTest

final class GreetTests: XCTestCase {
    func testGreeting() {
        let words = "Hello, world!".split(separator: " ")
        XCTAssertEqual(Array(words.uniqued()).count, 2)
    }
}
