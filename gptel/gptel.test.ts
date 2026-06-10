import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  defaultBackends,
  extractPrompt,
  gptelAddPostResponseFunction,
  gptelAddPromptTransform,
  gptelAddResponseFilter,
  gptelMakeAzure,
  gptelMakeDeepSeek,
  gptelMakeKagi,
  gptelMakeOllama,
  gptelMakeOpenAIResponses,
  gptelMakePerplexity,
  gptelMakePrivateGPT,
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
  ])
  expect(backends[1]!.apiKeyHeader).toBe("api-key")
  expect(backends[3]!.authorizationPrefix).toBe("Bot")
  const state = editor.locals.get("gptel-state") as { backends: Map<string, GptelBackend> }
  expect(state.backends.get("DeepSeek")?.defaultModel).toBe("deepseek-chat")
  expect(state.backends.get("xAI")?.host).toBe("api.x.ai")
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

test("gptelToolCallSummary formats tool confirmation details", () => {
  const summary = gptelToolCallSummary([
    { id: "1", name: "lookup", arguments: { q: "jemacs" } },
    { id: "2", name: "read_file", arguments: { path: "/tmp/a.ts" } },
  ])
  expect(summary).toContain("1. lookup\n{\n  \"q\": \"jemacs\"\n}")
  expect(summary).toContain("2. read_file")
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
