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
//   --probe        prints one line  {"available":true,"toolCalling":true}
//                  or               {"available":false,"reason":"..."}
//                  then exits 0. ("toolCalling" is the capability handshake —
//                  the Node client only sends tools when it is true. Bridges
//                  built before tool calling omit the field.)
//   otherwise      read JSON lines from stdin. Request:
//                    {"id":1,"op":"chat","system":"...",
//                     "messages":[{"role":"user","content":"..."}, ...],
//                     "tools":[{"name":"...","description":"...",
//                              "parameters":"{...json schema...}"}]}
//                  Respond one line per request:
//                    {"id":1,"text":"..."}  or  {"id":1,"error":"..."}
//                  With tools, the turn is multi-line: the bridge emits
//                    {"id":1,"tool_call":{"callId":1,"name":"...","arguments":"{...}"}}
//                  and waits for the matching
//                    {"id":1,"tool_result":{"callId":1,"result":"..."}}
//                  (callIds pair each call with its result) until it emits the
//                  final {"id":1,"text":"..."}. The bridge stays alive across
//                  requests; it exits on stdin EOF.
//
// Role mapping: "system" messages (plus the top-level "system" field) are folded
// into the session instructions. "user" messages are replayed through
// session.respond(to:); "assistant" messages are skipped because the session's own
// transcript already carries them once a user turn has been answered.
//
// Tool calling: when the request carries "tools", the bridge builds one dynamic
// Tool per definition (a single @Generable Arguments struct carrying JSON-encoded
// args works around the compile-time associated-type limitation — per-tool
// parameter schemas can't be expressed as Swift types at runtime, so the schema
// is embedded in each tool's description and the model fills one "json" string).
// The framework executes tools automatically inside respond(to:); each Swift
// call writes a {"id","tool_call":{...}} line and blocks reading the matching
// {"id","tool_result":{...}} line, which the Node parent services with the real
// tool implementations. The final {"id","text":"..."} ends the turn.

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
    let tools: [ToolDef]?

    private enum CodingKeys: String, CodingKey { case id, op, system, messages, tools }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(JSONValue.self, forKey: .id)
        op = try c.decode(String.self, forKey: .op)
        system = try c.decodeIfPresent(String.self, forKey: .system)
        messages = try c.decode([BridgeMessage].self, forKey: .messages)
        tools = try c.decodeIfPresent([ToolDef].self, forKey: .tools)
    }
}

/// One tool definition from the Node parent. `parameters` arrives as a
/// JSON-encoded string because the schema shape is dynamic per tool.
struct ToolDef: Decodable, Sendable {
    let name: String
    let description: String
    let parameters: String?
}

/// A tool-call request emitted to the Node parent on stdout.
struct ToolCallOut: Encodable {
    let callId: Int
    let name: String
    let arguments: String
}

/// A tool result read back from the Node parent on stdin.
struct ToolResultIn: Decodable {
    let callId: Int
    let result: String?
    let error: String?
}

struct ToolResultLine: Decodable {
    let id: JSONValue
    let tool_result: ToolResultIn
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
    /// Capability handshake: the Node client only sends tools when this is true.
    /// (Bridges built before tool calling existed omit it — treated as false.)
    let toolCalling: Bool

    enum CodingKeys: String, CodingKey { case available, reason, toolCalling }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(available, forKey: .available)
        if let reason { try c.encode(reason, forKey: .reason) }
        try c.encode(toolCalling, forKey: .toolCalling)
    }
}

enum BridgeError: Error {
    case unsupportedOp(String)
    case modelUnavailable(String)
    case unknownRole(String)
    case noUserMessages
    case toolResultMissing(String)
    case toolResultMismatch(Int)
    case malformedToolResult(String)

    var message: String {
        switch self {
        case .unsupportedOp(let op): return "unsupported op: \(op)"
        case .modelUnavailable(let reason): return "Apple Foundation Models unavailable: \(reason)"
        case .unknownRole(let role): return "unknown message role: \(role)"
        case .noUserMessages: return "request contains no user messages"
        case .toolResultMissing(let name): return "no tool_result received for tool call '\(name)' (parent hung up)"
        case .toolResultMismatch(let callId): return "tool_result callId mismatch (expected \(callId))"
        case .malformedToolResult(let line): return "malformed tool_result line: \(line.prefix(120))"
        }
    }
}

// MARK: - Tool calling machinery (all macOS 26+ only)

/// Single shared stdin line reader. The serve loop and the tool-result reads
/// must share one buffer — mixing readLine with raw FileHandle reads risks
/// losing buffered bytes.
final class StdinLineReader: @unchecked Sendable {
    private var buf = Data()
    private var eof = false

    /// Returns the next line without its newline, or nil on EOF.
    func nextLine() -> String? {
        while true {
            if let nl = buf.firstIndex(of: 0x0A) {
                let lineData = buf[buf.startIndex..<nl]
                buf.removeSubrange(buf.startIndex...nl)
                return String(data: lineData, encoding: .utf8)
            }
            if eof {
                guard !buf.isEmpty else { return nil }
                let lineData = buf
                buf.removeAll()
                return String(data: lineData, encoding: .utf8)
            }
            do {
                if let chunk = try FileHandle.standardInput.read(upToCount: 65536), !chunk.isEmpty {
                    buf.append(chunk)
                } else {
                    eof = true
                }
            } catch {
                eof = true
            }
        }
    }
}

/// Serializes tool calls onto the single stdio channel. The framework may
/// invoke tools concurrently; the actor guarantees each tool_call emission is
/// paired with its own tool_result read before the next call starts.
@available(macOS 26, *)
actor ToolCallBroker {
    private let requestId: JSONValue
    private let stdin: StdinLineReader
    private var nextCallId = 1

    init(requestId: JSONValue, stdin: StdinLineReader) {
        self.requestId = requestId
        self.stdin = stdin
    }

    func callTool(name: String, argumentsJSON: String) throws -> String {
        let callId = nextCallId
        nextCallId += 1
        emitToolCall(callId: callId, name: name, arguments: argumentsJSON)
        guard let line = stdin.nextLine() else {
            throw BridgeError.toolResultMissing(name)
        }
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(ToolResultLine.self, from: data)
        else {
            throw BridgeError.malformedToolResult(trimmed)
        }
        guard decoded.tool_result.callId == callId else {
            throw BridgeError.toolResultMismatch(callId)
        }
        if let error = decoded.tool_result.error {
            // Propagate: the framework aborts respond(to:) and the turn fails
            // loudly rather than silently swallowing a broken tool.
            throw BridgeError.modelUnavailable("tool '\(name)' failed: \(error)")
        }
        return decoded.tool_result.result ?? ""
    }

    private func emitToolCall(callId: Int, name: String, arguments: String) {
        struct Out: Encodable {
            let id: JSONValue
            let tool_call: ToolCallOut
        }
        Bridge.emit(Out(id: requestId, tool_call: ToolCallOut(callId: callId, name: name, arguments: arguments)))
    }
}

/// One dynamic tool per definition from the Node parent.
///
/// The associated-type limitation: `Tool.Arguments` must be a single
/// compile-time `@Generable` type, but tool schemas arrive at runtime.
/// So every dynamic tool shares `Arguments{ json: String }` and the real
/// parameter schema is embedded in the tool `description` (the framework
/// injects name + description + schema into the prompt, so the model still
/// sees the full argument contract and encodes it as the `json` string).
@available(macOS 26, *)
struct DynamicBridgeTool: Tool {
    let name: String
    let description: String
    let broker: ToolCallBroker

    @Generable
    struct Arguments {
        @Guide(description: "The tool arguments as a single JSON object string, matching the schema documented in the tool description.")
        var json: String
    }

    func call(arguments: Arguments) async throws -> String {
        try await broker.callTool(name: name, argumentsJSON: arguments.json)
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
    /// The `#available` fallback is live when the deployment target is older
    /// than macOS 26 (build.sh only ever builds on 26+, so in practice the
    /// first branch is taken).
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
        emit(ProbeResult(available: available, reason: reason, toolCalling: true))
    }

    // MARK: Serving

    static func serve() async {
        let (available, reason) = modelAvailability()
        if !available {
            log("starting with model unavailable: \(reason ?? "unknown reason") — every request will error")
        }
        let stdin = StdinLineReader()
        while let line = stdin.nextLine() {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            await handle(line: trimmed, stdin: stdin)
        }
        log("stdin closed, exiting")
    }

    static func handle(line: String, stdin: StdinLineReader) async {
        let decoder = JSONDecoder()
        guard let data = line.data(using: .utf8),
              let req = try? decoder.decode(ChatRequest.self, from: data)
        else {
            // Couldn't parse a request id, so echo null — but never go silent.
            emit(BridgeResponse(id: .null, text: nil, error: "malformed request: not valid JSON"))
            return
        }
        do {
            let text = try await chat(request: req, stdin: stdin)
            emit(BridgeResponse(id: req.id, text: text, error: nil))
        } catch let err as BridgeError {
            emit(BridgeResponse(id: req.id, text: nil, error: err.message))
        } catch {
            emit(BridgeResponse(id: req.id, text: nil, error: String(describing: error)))
        }
    }

    static func chat(request: ChatRequest, stdin: StdinLineReader) async throws -> String {
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
        let instructions = instructionParts.joined(separator: "\n\n")
        let toolDefs = request.tools ?? []

        if #available(macOS 26, *) {
            if toolDefs.isEmpty {
                return try await chatTextOnly(request: request, instructions: instructions)
            }
            return try await chatWithTools(request: request, instructions: instructions, toolDefs: toolDefs, stdin: stdin)
        } else {
            // Only reachable with a deployment target older than macOS 26.
            throw BridgeError.modelUnavailable("requires macOS 26 (Tahoe) or later")
        }
    }

    /// The original text-only path: replay user turns so the session
    /// transcript carries the history. Unchanged behavior for tool-free turns.
    @available(macOS 26, *)
    static func chatTextOnly(request: ChatRequest, instructions: String) async throws -> String {
        let session = LanguageModelSession(instructions: instructions)
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
    }

    /// Tool path: ONE respond(to:) with the whole conversation rendered as a
    /// single prompt, so historical turns can't re-trigger side-effecting
    /// tools — only the latest message drives tool use. The framework runs the
    /// tool loop internally: each DynamicBridgeTool.call round-trips through
    /// the broker to the Node parent, and respond returns the final text.
    @available(macOS 26, *)
    static func chatWithTools(
        request: ChatRequest,
        instructions: String,
        toolDefs: [ToolDef],
        stdin: StdinLineReader
    ) async throws -> String {
        let broker = ToolCallBroker(requestId: request.id, stdin: stdin)
        let tools: [any Tool] = toolDefs.map { def in
            var desc = def.description
            if let schema = def.parameters, !schema.isEmpty {
                desc += "\n\nArguments — provide as a single JSON object string in the 'json' field, matching this schema:\n\(schema)"
            }
            return DynamicBridgeTool(name: def.name, description: desc, broker: broker)
        }
        let session = LanguageModelSession(tools: tools, instructions: instructions)
        let prompt = renderConversation(request.messages)
        let response = try await session.respond(to: prompt)
        return response.content
    }

    /// Renders the conversation for the single-prompt tool path.
    static func renderConversation(_ messages: [BridgeMessage]) -> String {
        var parts: [String] = []
        for m in messages {
            switch m.role {
            case "user":
                parts.append("User: \(m.content)")
            case "assistant":
                parts.append("Assistant: \(m.content)")
            case "tool":
                parts.append("Tool result: \(m.content)")
            case "system":
                continue // folded into instructions
            default:
                parts.append("User: \(m.content)")
            }
        }
        return parts.joined(separator: "\n\n")
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
