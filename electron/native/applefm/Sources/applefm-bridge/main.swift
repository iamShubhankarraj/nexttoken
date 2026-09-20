// applefm-bridge — stdio JSON-lines bridge to Apple's FoundationModels framework.
//
// What this is: a tiny macOS executable that lets the Next Token Electron app use
// the on-device Apple Foundation Models LLM without any SDK in the main process.
// It speaks newline-delimited JSON on stdin/stdout so any language can drive it.
//
// FoundationModels API used (Apple, macOS 26 / Tahoe and later; WWDC25 session 271
// "Meet the Foundation Models framework"):
//   - SystemLanguageModel.default.availability -> SystemLanguageModel.Availability
//       (.available, or .unavailable(UnavailabilityReason) with reasons such as
//       .deviceNotEligible / .appleIntelligenceNotEnabled / .modelNotReady)
//   - LanguageModelSession(instructions:) — system instructions; the init accepts a
//       plain String (mirrors Apple's own sample code)
//   - session.respond(to:) — takes a plain String prompt, returns Response<String>;
//       transcript history accumulates in the session, so the caller replays user
//       turns in order and the final response is returned
//   - response.content — the generated text
//
// Protocol:
//   --probe        prints one line  {"available":true}
//                  or               {"available":false,"reason":"..."}
//                  then exits 0.
//   otherwise      read JSON lines from stdin. Request:
//                    {"id":1,"op":"chat","system":"...",
//                     "messages":[{"role":"user","content":"..."}, ...]}
//                  Respond one line per request:
//                    {"id":1,"text":"..."}  or  {"id":1,"error":"..."}
//                  The bridge stays alive across requests; it exits on stdin EOF.
//
// Role mapping: "system" messages (plus the top-level "system" field) are folded
// into the session instructions. "user" messages are replayed through
// session.respond(to:); "assistant" messages are skipped because the session's own
// transcript already carries them once a user turn has been answered. Apple
// Foundation Models does not support tool calling, so this bridge is text-only.

import Foundation
import FoundationModels

// MARK: - JSON protocol types

/// A request id that round-trips in whatever JSON form it arrived in.
enum JSONValue: Codable, Sendable {
    case int(Int)
    case double(Double)
    case string(String)
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let i = try? c.decode(Int.self) {
            self = .int(i)
        } else if let d = try? c.decode(Double.self) {
            self = .double(d)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else {
            throw DecodingError.typeMismatch(
                JSONValue.self,
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "expected a number, string, or null"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .string(let s): try c.encode(s)
        case .null: try c.encodeNil()
        }
    }
}

struct BridgeMessage: Decodable, Sendable {
    let role: String
    let content: String
}

struct ChatRequest: Decodable, Sendable {
    let id: JSONValue
    let op: String
    let system: String?
    let messages: [BridgeMessage]
}

struct BridgeResponse: Encodable {
    let id: JSONValue
    let text: String?
    let error: String?

    enum CodingKeys: String, CodingKey { case id, text, error }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        if let text { try c.encode(text, forKey: .text) }
        if let error { try c.encode(error, forKey: .error) }
    }
}

struct ProbeResult: Encodable {
    let available: Bool
    let reason: String?

    enum CodingKeys: String, CodingKey { case available, reason }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(available, forKey: .available)
        if let reason { try c.encode(reason, forKey: .reason) }
    }
}

enum BridgeError: Error {
    case unsupportedOp(String)
    case modelUnavailable(String)
    case unknownRole(String)
    case noUserMessages

    var message: String {
        switch self {
        case .unsupportedOp(let op): return "unsupported op: \(op)"
        case .modelUnavailable(let reason): return "Apple Foundation Models unavailable: \(reason)"
        case .unknownRole(let role): return "unknown message role: \(role)"
        case .noUserMessages: return "request contains no user messages"
        }
    }
}

// MARK: - Bridge

@main
struct Bridge {
    static func main() async {
        setlinebuf(stdout)

        if CommandLine.arguments.contains("--probe") {
            runProbe()
            return
        }

        await serve()
    }

    // MARK: Availability

    /// Checks `#available(macOS 26, *)` AND the real model availability gate.
    /// The `#available` branch is unreachable given the macOS 26 deployment
    /// target; it is kept so the intent is explicit if the target ever changes.
    static func modelAvailability() -> (available: Bool, reason: String?) {
        if #available(macOS 26, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return (true, nil)
            case .unavailable(let reason):
                return (false, String(describing: reason))
            }
        } else {
            return (false, "requires macOS 26 (Tahoe) or later")
        }
    }

    static func runProbe() {
        let (available, reason) = modelAvailability()
        emit(ProbeResult(available: available, reason: reason))
    }

    // MARK: Serving

    static func serve() async {
        let (available, reason) = modelAvailability()
        if !available {
            log("starting with model unavailable: \(reason ?? "unknown reason") — every request will error")
        }
        while let line = readLine(strippingNewline: true) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            await handle(line: trimmed)
        }
        log("stdin closed, exiting")
    }

    static func handle(line: String) async {
        let decoder = JSONDecoder()
        guard let data = line.data(using: .utf8),
              let req = try? decoder.decode(ChatRequest.self, from: data)
        else {
            // Couldn't parse a request id, so echo null — but never go silent.
            emit(BridgeResponse(id: .null, text: nil, error: "malformed request: not valid JSON"))
            return
        }
        do {
            let text = try await chat(request: req)
            emit(BridgeResponse(id: req.id, text: text, error: nil))
        } catch let err as BridgeError {
            emit(BridgeResponse(id: req.id, text: nil, error: err.message))
        } catch {
            emit(BridgeResponse(id: req.id, text: nil, error: String(describing: error)))
        }
    }

    static func chat(request: ChatRequest) async throws -> String {
        guard request.op == "chat" else {
            throw BridgeError.unsupportedOp(request.op)
        }
        let (available, reason) = modelAvailability()
        guard available else {
            throw BridgeError.modelUnavailable(reason ?? "unknown reason")
        }

        // System content becomes session instructions; user/assistant turns go
        // through respond(to:) so the session's transcript carries the history.
        var instructionParts: [String] = []
        if let system = request.system, !system.isEmpty {
            instructionParts.append(system)
        }
        for m in request.messages where m.role == "system" {
            instructionParts.append(m.content)
        }

        if #available(macOS 26, *) {
            let session = LanguageModelSession(instructions: instructionParts.joined(separator: "\n\n"))
            var lastText: String?
            for m in request.messages {
                switch m.role {
                case "user":
                    let response = try await session.respond(to: m.content)
                    lastText = response.content
                case "assistant", "system":
                    // Already represented: instructions for system, session
                    // transcript for prior assistant turns.
                    continue
                default:
                    throw BridgeError.unknownRole(m.role)
                }
            }
            guard let text = lastText else {
                throw BridgeError.noUserMessages
            }
            return text
        } else {
            // Unreachable with the macOS 26 deployment target.
            throw BridgeError.modelUnavailable("requires macOS 26 (Tahoe) or later")
        }
    }

    // MARK: - IO helpers

    /// Writes one JSON line to stdout and flushes immediately, so the parent
    /// process never waits on a buffered block.
    static func emit(_ value: some Encodable) {
        do {
            let data = try JSONEncoder().encode(value)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A]))
            fflush(stdout)
        } catch {
            log("failed to encode response: \(error)")
        }
    }

    static func log(_ message: String) {
        if let data = "[applefm-bridge] \(message)\n".data(using: .utf8) {
            FileHandle.standardError.write(data)
        }
    }
}
