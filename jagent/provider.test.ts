import { expect, test } from "bun:test"
import { completeWithTools, resolveJagentProvider, serializeTranscript } from "./provider"
import type { JagentSettings } from "./types"

function baseSettings(overrides: Partial<JagentSettings> = {}): JagentSettings {
  return {
    provider: "auto",
    defaultProvider: "auto",
    model: "",
    defaultModel: "",
    systemPrompt: "",
    providerSystemPrompts: {},
    modelSystemPrompts: {},
    customProviders: {},
    mockResponses: [],
    apiKeys: {
      gemini: "",
      openai: "",
      anthropic: "",
    },
    maxToolRounds: 8,
    bashTimeoutMs: 120_000,
    ...overrides,
  }
}

test("resolves configured default provider and model", () => {
  const resolved = resolveJagentProvider(baseSettings({
    defaultProvider: "openai",
    defaultModel: "gpt-test",
    apiKeys: { gemini: "", openai: "sk-test", anthropic: "" },
  }))

  expect(resolved.name).toBe("openai")
  expect(resolved.kind).toBe("openai")
  expect(resolved.model).toBe("gpt-test")
  expect(resolved.label).toBe("openai/gpt-test")
})

test("resolves custom OpenAI-compatible providers", () => {
  const resolved = resolveJagentProvider(baseSettings({
    provider: "local-gemini",
    customProviders: {
      "local-gemini": {
        kind: "openai-compatible",
        baseURL: "https://example.test/v1",
        defaultModel: "gemini-test",
        headers: { "x-test": "1" },
      },
    },
  }))

  expect(resolved.name).toBe("local-gemini")
  expect(resolved.kind).toBe("openai-compatible")
  expect(resolved.model).toBe("gemini-test")
  expect(resolved.baseURL).toBe("https://example.test/v1")
  expect(resolved.headers?.["x-test"]).toBe("1")
})

test("uses model-specific system prompts before provider prompts", () => {
  const resolved = resolveJagentProvider(baseSettings({
    provider: "gemini",
    model: "gemini-special",
    providerSystemPrompts: { gemini: "provider prompt" },
    modelSystemPrompts: { "gemini/gemini-special": "model prompt" },
    apiKeys: { gemini: "test", openai: "", anthropic: "" },
  }))

  expect(resolved.systemPrompt).toBe("model prompt")
  expect(serializeTranscript([{ role: "user", content: "hi", at: "now" }], resolved.systemPrompt))
    .toStartWith("model prompt")
})

test("mock provider uses AI SDK mock model for deterministic text", async () => {
  const completion = await completeWithTools(baseSettings({
    provider: "mock",
    mockResponses: ["hello from mock"],
  }), [
    { role: "user", content: "hello", at: "now" },
  ])

  expect(completion.content).toBe("hello from mock")
  expect(completion.toolCalls).toEqual([])
  expect(completion.model).toBe("mock/mock")
})

test("mock provider can return tool calls through AI SDK generateText", async () => {
  const completion = await completeWithTools(baseSettings({
    provider: "mock",
    mockResponses: [{
      content: "I will inspect it.",
      toolCalls: [{
        id: "call-1",
        name: "read_file",
        args: { path: "README.md" },
      }],
    }],
  }), [
    { role: "user", content: "read the readme", at: "now" },
  ])

  expect(completion.content).toBe("I will inspect it.")
  expect(completion.toolCalls).toEqual([{
    id: "call-1",
    name: "read_file",
    args: { path: "README.md" },
  }])
})
