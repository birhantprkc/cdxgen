import ArgumentParser

struct Greet: ParsableCommand {
    @Option(help: "Name to greet")
    var name = "world"

    func run() throws {
        let greeting = "Hello, \(name)!"
        print(greeting)
    }
}

Greet.main()
