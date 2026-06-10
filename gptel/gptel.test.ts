import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  defaultBackends,
  extractPrompt,
  formatToolResultBlock,
  gptelAddPostResponseFunction,
  gptelAddPromptTransform,
  gptelAddResponseFilter,
  gptelMakeAzure,
  gptelMakeBedrock,
  gptelMakeDeepSeek,
  gptelMakeKagi,
  gptelMakeGithubCopilot,
  gptelMakeOllama,
  gptelMakeOpenAI,
  gptelMakeOpenAIOAuth,
  gptelMakeOpenAIResponses,
  gptelMakePerplexity,
  gptelMakePrivateGPT,
  gptelMakeTool,
  gptelMakeXAI,
  gptelToolCallSummary,
  mediaPartsFromContext,
  mimeTypeForPath,
  parseSseEvents,
  providerMessagesForBackend,
  renderContext,
  renderContextBuffer,
  responseRanges,
  toolCallsFromJson,
  usageFromJson,
  install,
  type GptelBackend,
  type GptelMessage,
} from "./gptel"
import { BufferModel, Editor, setCustom } from "@jemacs/core"

test("default backends include Stephen's configured Claude backend", () => {
  const claude = defaultBackends().find(backend => backend.name === "Claude")
  expect(claude?.kind).toBe("anthropic")
  expect(claude?.defaultModel).toBe("claude-sonnet-4-5-20250929")
})

test("backend factories cover upstream provider families", () => {
  const editor = new Editor()
  const backends = [
    gptelMakeOpenAIResponses(editor, "Responses"),
    gptelMakeAzure(editor, "Azure", { host: "example.openai.azure.com" }),
    gptelMakeOllama(editor, "Local"),
    gptelMakeKagi(editor, "Kagi", { key: "kagi-key" }),
    gptelMakePrivateGPT(editor, "Private"),
    gptelMakePerplexity(editor, "Perplexity"),
    gptelMakeDeepSeek(editor, "DeepSeek"),
    gptelMakeXAI(editor, "xAI"),
    gptelMakeBedrock(editor, "Bedrock", { key: "bedrock-token" }),
    gptelMakeGithubCopilot(editor, "Copilot", { key: "copilot-token" }),
    gptelMakeOpenAIOAuth(editor, "ChatGPT OAuth", { key: "oauth-token" }),
  ]
  expect(backends.map(backend => backend.kind)).toEqual([
    "openai-responses",
    "openai",
    "ollama",
    "kagi",
    "openai",
    "openai",
    "openai",
    "openai",
    "bedrock",
    "openai",
    "openai-responses",
  ])
  expect(backends[1]!.apiKeyHeader).toBe("api-key")
  expect(backends[3]!.authorizationPrefix).toBe("Bot")
  const state = editor.locals.get("gptel-state") as { backends: Map<string, GptelBackend> }
  expect(state.backends.get("DeepSeek")?.defaultModel).toBe("deepseek-chat")
  expect(state.backends.get("xAI")?.host).toBe("api.x.ai")
  expect(state.backends.get("Bedrock")?.endpoint).toBe("/model/{model}/converse")
  expect(state.backends.get("Copilot")?.headers?.["copilot-integration-id"]).toBe("vscode-chat")
  expect(state.backends.get("ChatGPT OAuth")?.host).toBe("chatgpt.com")
})

test("extractPrompt prefers active region", () => {
  const buffer = new BufferModel({ name: "x", text: "hello world" })
  buffer.point = 11
  buffer.mark = 6
  buffer.markActive = true
  expect(extractPrompt(buffer).prompt).toBe("world")
})

test("extractPrompt reads last gptel chat user turn", () => {
  const buffer = new BufferModel({ name: "*ChatGPT*", mode: "gptel-chat", text: "User:\nfirst\n\nAssistant:\nsecond\n\nUser:\nthird" })
  buffer.point = buffer.text.length
  expect(extractPrompt(buffer).prompt).toBe("third")
})

test("extractPrompt and responseRanges support custom chat markers", () => {
  const markers = { promptPrefix: "Q> ", responsePrefix: "A> ", separator: "\n---\n" }
  const buffer = new BufferModel({ name: "*ChatGPT*", mode: "gptel-chat", text: "Q> first\n---\nA> second\n---\nQ> third" })
  buffer.point = buffer.text.length
  expect(extractPrompt(buffer, markers).prompt).toBe("third")
  expect(responseRanges(buffer, markers)).toEqual([{ start: 16, end: 22 }])
})

test("renderContext includes buffers and files", () => {
  const text = renderContext([
    { type: "buffer", name: "a.ts", bufferId: "1", text: "const a = 1" },
    { type: "file", path: "/tmp/b.ts", text: "const b = 2" },
  ])
  expect(text).toContain("Buffer: a.ts")
  expect(text).toContain("File: /tmp/b.ts")
})

test("renderContextBuffer creates navigable sections and deletion markers", () => {
  const rendered = renderContextBuffer([
    { type: "buffer", name: "a.ts", bufferId: "1", text: "alpha\nbeta" },
    { type: "file", path: "/tmp/b.ts", text: "gamma" },
  ], new Set([1]))
  expect(rendered.text).toContain("[ ] 1. Buffer: a.ts")
  expect(rendered.text).toContain("[D] 2. File: /tmp/b.ts")
  expect(rendered.sections).toHaveLength(2)
  expect(rendered.sections[0]!.start).toBeLessThan(rendered.sections[0]!.end)
  expect(rendered.sections[1]!.start).toBeGreaterThan(rendered.sections[0]!.end)
})

test("mimeTypeForPath identifies common gptel media types", () => {
  expect(mimeTypeForPath("x.png")).toBe("image/png")
  expect(mimeTypeForPath("x.jpeg")).toBe("image/jpeg")
  expect(mimeTypeForPath("x.pdf")).toBe("application/pdf")
  expect(mimeTypeForPath("x.unknown")).toBeNull()
})

test("mediaPartsFromContext reads binary file context as base64", () => {
  const dir = mkdtempSync(join(tmpdir(), "gptel-media-"))
  try {
    const path = join(dir, "tiny.png")
    writeFileSync(path, Buffer.from([1, 2, 3, 4]))
    expect(mediaPartsFromContext([{ type: "file", path, text: "", binary: true, mime: "image/png" }])).toEqual([
      { path, mime: "image/png", base64: "AQIDBA==" },
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("providerMessagesForBackend embeds media in provider-specific shapes", () => {
  const messages: GptelMessage[] = [{
    role: "user",
    content: "describe",
    media: [{ path: "/tmp/tiny.png", mime: "image/png", base64: "AQIDBA==" }],
  }]

  expect(providerMessagesForBackend({ name: "OpenAI", kind: "openai", models: ["gpt-4.1"] }, messages)).toEqual([{
    role: "user",
    content: [
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AQIDBA==" } },
    ],
  }])
  expect(providerMessagesForBackend({ name: "Responses", kind: "openai-responses", models: ["gpt-4.1"] }, messages)).toEqual([{
    role: "user",
    content: [
      { type: "input_text", text: "describe" },
      { type: "input_image", image_url: "data:image/png;base64,AQIDBA==" },
    ],
  }])
  expect(providerMessagesForBackend({ name: "Claude", kind: "anthropic", models: ["claude"] }, messages)).toEqual([{
    role: "user",
    content: [
      { type: "text", text: "describe" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQIDBA==" } },
    ],
  }])
  expect(providerMessagesForBackend({ name: "Gemini", kind: "gemini", models: ["gemini"] }, messages)).toEqual([{
    role: "user",
    parts: [
      { text: "describe" },
      { inline_data: { mime_type: "image/png", data: "AQIDBA==" } },
    ],
  }])
  expect(providerMessagesForBackend({ name: "Ollama", kind: "ollama", models: ["llava"] }, messages)).toEqual([{
    role: "user",
    content: "describe",
    images: ["AQIDBA=="],
  }])
  expect(providerMessagesForBackend({ name: "Bedrock", kind: "bedrock", models: ["claude"] }, messages)).toEqual([{
    role: "user",
    content: [
      { text: "describe" },
      { image: { format: "png", source: { bytes: "AQIDBA==" } } },
    ],
  }])
})

test("parseSseEvents joins data lines", () => {
  expect(parseSseEvents("data: one\ndata: two\n\n: ping\n\ndata: three\n\n")).toEqual(["one\ntwo", "three"])
})

test("toolCallsFromJson parses OpenAI chat tool calls", () => {
  const backend = { name: "ChatGPT", kind: "openai", models: ["gpt-4.1"] } satisfies GptelBackend
  expect(toolCallsFromJson(backend, {
    choices: [{
      message: {
        tool_calls: [{
          id: "call_1",
          function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
        }],
      },
    }],
  })).toEqual([{ id: "call_1", name: "read_file", arguments: { path: "a.ts" } }])
})

test("toolCallsFromJson parses OpenAI Responses function calls", () => {
  const backend = { name: "Responses", kind: "openai-responses", models: ["gpt-4.1"] } satisfies GptelBackend
  expect(toolCallsFromJson(backend, {
    output: [{ type: "function_call", call_id: "call_2", name: "grep", arguments: "{\"pattern\":\"x\"}" }],
  })).toEqual([{ id: "call_2", name: "grep", arguments: { pattern: "x" } }])
})

test("toolCallsFromJson parses Anthropic tool_use blocks", () => {
  const backend = { name: "Claude", kind: "anthropic", models: ["claude"] } satisfies GptelBackend
  expect(toolCallsFromJson(backend, {
    content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "pwd" } }],
  })).toEqual([{ id: "toolu_1", name: "bash", arguments: { command: "pwd" } }])
})

test("Bedrock response parsing supports text, tool calls, and usage", () => {
  const backend = { name: "Bedrock", kind: "bedrock", models: ["claude"] } satisfies GptelBackend
  const response = {
    output: {
      message: {
        content: [
          { text: "hello" },
          { toolUse: { toolUseId: "tool_1", name: "lookup", input: { q: "jemacs" } } },
        ],
      },
    },
    usage: { inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 2, cacheWriteInputTokens: 1 },
  }
  expect(toolCallsFromJson(backend, response)).toEqual([{ id: "tool_1", name: "lookup", arguments: { q: "jemacs" } }])
  expect(usageFromJson(backend, response)).toEqual({ input: 8, output: 3, cached: 2, cache: 1 })
})

test("usageFromJson normalizes provider token usage", () => {
  expect(usageFromJson({ name: "OpenAI", kind: "openai", models: ["gpt-4.1"] }, {
    usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
  })).toEqual({ input: 10, output: 5, cached: 2 })
  expect(usageFromJson({ name: "Claude", kind: "anthropic", models: ["claude"] }, {
    usage: { input_tokens: 8, output_tokens: 4, cache_creation_input_tokens: 3, cache_read_input_tokens: 2 },
  })).toEqual({ input: 11, output: 4, cached: 2, cache: 3 })
})

test("gptelToolCallSummary formats tool confirmation details", () => {
  const summary = gptelToolCallSummary([
    { id: "1", name: "lookup", arguments: { q: "jemacs" } },
    { id: "2", name: "read_file", arguments: { path: "/tmp/a.ts" } },
  ])
  expect(summary).toContain("1. lookup\n{\n  \"q\": \"jemacs\"\n}")
  expect(summary).toContain("2. read_file")
})

test("formatToolResultBlock renders markdown tool results", () => {
  expect(formatToolResultBlock(
    { id: "1", name: "lookup", arguments: { q: "jemacs" } },
    { role: "tool", toolCallId: "1", name: "lookup", content: "found it" },
  )).toContain("``` tool (lookup {")
})

test("gptel variant commands switch the last response in place", async () => {
  const editor = new Editor()
  await install(editor)
  setCustom("gptel-backend", "Mock")
  setCustom("gptel-model", "mock")
  const buffer = editor.scratch("*ChatGPT-test*", "User:\nhello", "gptel-chat")
  buffer.point = buffer.text.length
  editor.switchToBuffer(buffer.id)
  await editor.run("gptel-send")

  const state = editor.locals.get("gptel-state") as {
    lastRequest: { responseStart: number; responseEnd: number; variants: string[]; variantIndex: number }
  }
  state.lastRequest.variants.push("alternate response")
  await editor.run("gptel-previous-variant")

  expect(buffer.text.slice(state.lastRequest.responseStart, state.lastRequest.responseEnd)).toBe("alternate response")
  expect(state.lastRequest.variantIndex).toBe(1)
})

test("gptel prompt transforms, response filters, and post-response functions run", async () => {
  const editor = new Editor()
  await install(editor)
  setCustom("gptel-backend", "Mock")
  setCustom("gptel-model", "mock")
  const seen: Array<string | number> = []
  gptelAddPromptTransform(editor, prompt => `${prompt} transformed`)
  gptelAddResponseFilter(editor, response => response.replace("transformed", "filtered"))
  gptelAddPostResponseFunction(editor, (start, end) => {
    seen.push(start, end)
  })
  const buffer = editor.scratch("*ChatGPT-hooks*", "User:\nhello", "gptel-chat")
  buffer.point = buffer.text.length
  editor.switchToBuffer(buffer.id)
  await editor.run("gptel-send")

  expect(buffer.text).toContain("Mock response to: hello filtered")
  expect(seen).toHaveLength(2)
})

test("gptel-send honors custom prompt and response markers", async () => {
  const editor = new Editor()
  await install(editor)
  setCustom("gptel-backend", "Mock")
  setCustom("gptel-model", "mock")
  setCustom("gptel-prompt-prefix", "Q> ")
  setCustom("gptel-response-prefix", "A> ")
  setCustom("gptel-response-separator", "\n---\n")
  const buffer = editor.scratch("*ChatGPT-custom*", "Q> hello", "gptel-chat")
  buffer.point = buffer.text.length
  editor.switchToBuffer(buffer.id)
  await editor.run("gptel-send")

  expect(buffer.text).toContain("\n---\nA> Mock response to: hello\n---\nQ> ")
  expect(extractPrompt(buffer, { promptPrefix: "Q> ", responsePrefix: "A> ", separator: "\n---\n" }).prompt).toBe("")

  setCustom("gptel-prompt-prefix", "User:\n")
  setCustom("gptel-response-prefix", "Assistant:\n")
  setCustom("gptel-response-separator", "\n\n")
})

test("gptel response navigation and marking use response ranges", async () => {
  const editor = new Editor()
  await install(editor)
  const buffer = editor.scratch("*ChatGPT-nav*", "User:\none\n\nAssistant:\ntwo\n\nUser:\nthree\n\nAssistant:\nfour", "gptel-chat")
  buffer.point = 0
  editor.switchToBuffer(buffer.id)

  await editor.run("gptel-end-of-response")
  expect(buffer.point).toBe("User:\none\n\nAssistant:\ntwo".length)
  await editor.run("gptel-end-of-response")
  expect(buffer.point).toBe(buffer.text.length)
  await editor.run("gptel-beginning-of-response")
  expect(buffer.text.slice(buffer.point, buffer.point + 4)).toBe("four")
  await editor.run("gptel-mark-response")
  expect(buffer.markActive).toBe(true)
  expect(buffer.text.slice(Math.min(buffer.point, buffer.mark!), Math.max(buffer.point, buffer.mark!))).toBe("four")
})

test("gptel rewrite accept and reject manage pending rewrite state", async () => {
  const editor = new Editor()
  await install(editor)
  setCustom("gptel-backend", "Mock")
  setCustom("gptel-model", "mock")
  const buffer = editor.scratch("rewrite.txt", "alpha beta gamma", "text")
  buffer.mark = 6
  buffer.point = 10
  buffer.markActive = true
  editor.switchToBuffer(buffer.id)
  await editor.run("gptel-rewrite", ["shorten"])

  expect(buffer.text).not.toBe("alpha beta gamma")
  const state = editor.locals.get("gptel-state") as { lastRewrite?: { original: string } }
  expect(state.lastRewrite?.original).toBe("beta")
  await editor.run("gptel-rewrite-reject")
  expect(buffer.text).toBe("alpha beta gamma")
  expect(state.lastRewrite).toBeUndefined()

  buffer.mark = 6
  buffer.point = 10
  buffer.markActive = true
  await editor.run("gptel-rewrite", ["shorten"])
  expect(state.lastRewrite?.original).toBe("beta")
  await editor.run("gptel-rewrite-accept")
  expect(state.lastRewrite).toBeUndefined()
})

test("gptel-send sends tools and inserts included tool results", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeOpenAI(editor, "ToolBackend", { endpoint: "http://tool.test/v1/chat/completions", models: ["tool-model"], defaultModel: "tool-model", stream: false })
  gptelMakeTool(editor, {
    name: "lookup",
    description: "Lookup a value.",
    confirm: false,
    include: true,
    parameters: { type: "object", properties: { q: { type: "string" } } },
    function: args => `result:${(args as { q?: string }).q ?? ""}`,
  })
  setCustom("gptel-backend", "ToolBackend")
  setCustom("gptel-model", "tool-model")
  setCustom("gptel-tools", "lookup")
  setCustom("gptel-use-tools", true)
  setCustom("gptel-include-tool-results", "auto")
  setCustom("gptel-confirm-tool-calls", false)
  setCustom("gptel-stream", false)
  const bodies: any[] = []
  const originalFetch = globalThis.fetch
  let callCount = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")))
    callCount += 1
    if (callCount === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"jemacs\"}" } }],
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    const buffer = editor.scratch("*ChatGPT-tools*", "User:\nhello", "gptel-chat")
    buffer.point = buffer.text.length
    editor.switchToBuffer(buffer.id)
    await editor.run("gptel-send")
    expect(bodies[0].tools).toHaveLength(1)
    expect(buffer.text).toContain("``` tool (lookup")
    expect(buffer.text).toContain("result:jemacs")
    expect(buffer.text).toContain("done")

    setCustom("gptel-use-tools", false)
    bodies.length = 0
    callCount = 1
    const second = editor.scratch("*ChatGPT-no-tools*", "User:\nhello", "gptel-chat")
    second.point = second.text.length
    editor.switchToBuffer(second.id)
    await editor.run("gptel-send")
    expect(bodies[0].tools).toBeUndefined()
  } finally {
    globalThis.fetch = originalFetch
    setCustom("gptel-tools", "")
    setCustom("gptel-use-tools", true)
    setCustom("gptel-include-tool-results", "auto")
    setCustom("gptel-confirm-tool-calls", true)
    setCustom("gptel-stream", true)
  }
})

test("gptel inspect reports last and session token usage", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeOpenAI(editor, "UsageBackend", { endpoint: "http://usage.test/v1/chat/completions", models: ["usage-model"], defaultModel: "usage-model", stream: false })
  setCustom("gptel-backend", "UsageBackend")
  setCustom("gptel-model", "usage-model")
  setCustom("gptel-stream", false)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: "usage done" } }],
    usage: { prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } },
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch
  try {
    const buffer = editor.scratch("*ChatGPT-usage*", "User:\nhello", "gptel-chat")
    buffer.point = buffer.text.length
    editor.switchToBuffer(buffer.id)
    await editor.run("gptel-send")
    await editor.run("gptel-inspect")
    expect(editor.activeBuffer.text).toContain("Last usage: 8 in, 1 cached, 3 out")
    expect(editor.activeBuffer.text).toContain("Session usage: 8 in, 1 cached, 3 out")
  } finally {
    globalThis.fetch = originalFetch
    setCustom("gptel-stream", true)
  }
})
