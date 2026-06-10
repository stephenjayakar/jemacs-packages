import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  defaultBackends,
  extractPrompt,
  mediaPartsFromContext,
  mimeTypeForPath,
  parseSseEvents,
  providerMessagesForBackend,
  renderContext,
  renderContextBuffer,
  toolCallsFromJson,
  type GptelBackend,
  type GptelMessage,
} from "./gptel"
import { BufferModel } from "@jemacs/core"

test("default backends include Stephen's configured Claude backend", () => {
  const claude = defaultBackends().find(backend => backend.name === "Claude")
  expect(claude?.kind).toBe("anthropic")
  expect(claude?.defaultModel).toBe("claude-sonnet-4-5-20250929")
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
