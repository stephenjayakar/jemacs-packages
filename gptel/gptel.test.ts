import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  convertMarkdownToOrg,
  defaultBackends,
  extractPrompt,
  formatToolResultBlock,
  gptelParseSchema,
  gptelAddPostResponseFunction,
  gptelAddPostToolCallFunction,
  gptelAddPromptTransform,
  gptelAddPreToolCallFunction,
  gptelAddResponseFilter,
  gptelMakeAnthropic,
  gptelMakeAzure,
  gptelMakeBedrock,
  gptelMakeDeepSeek,
  gptelMakeGemini,
  gptelMakeGhCopilot,
  gptelMakeGPT4All,
  gptelMakeKagi,
  gptelMakeGithubCopilot,
  gptelMakeDirective,
  gptelMakeOllama,
  gptelMakeOpenAI,
  gptelMakeOpenAIOAuth,
  gptelMakeOpenAIResponses,
  gptelMakePerplexity,
  gptelMakePrivateGPT,
  gptelMakeTool,
  gptelMakeXAI,
  gptelGetBackend,
  gptelGetTool,
  gptelMcpRegisterServer,
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
import { BufferModel, Editor, getCustom, setCustom } from "@jemacs/core"

test("default backends include Stephen's configured Claude backend", () => {
  const claude = defaultBackends().find(backend => backend.name === "Claude")
  expect(claude?.kind).toBe("anthropic")
  expect(claude?.defaultModel).toBe("claude-sonnet-4-5-20250929")
})

test("convertMarkdownToOrg translates common gptel response syntax", () => {
  const org = convertMarkdownToOrg([
    "# Title",
    "",
    "* item",
    "",
    "```ts",
    "const x = 1",
    "```",
    "",
    "Use `code` and *em*.",
  ].join("\n"))

  expect(org).toContain("* Title")
  expect(org).toContain("- item")
  expect(org).toContain("#+begin_src ts")
  expect(org).toContain("#+end_src")
  expect(org).toContain("=code=")
  expect(org).toContain("/em/")
})

test("gptelParseSchema supports JSON and upstream shorthand forms", () => {
  expect(gptelParseSchema("name, age int")).toEqual({
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
    additionalProperties: false,
    required: ["name", "age"],
    propertyOrdering: ["name", "age"],
  })
  expect(gptelParseSchema("[title: short title\nscore number: confidence]")).toEqual({
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "short title" },
            score: { type: "number", description: "confidence" },
          },
          additionalProperties: false,
          required: ["title", "score"],
          propertyOrdering: ["title", "score"],
        },
      },
    },
    additionalProperties: false,
    required: ["items"],
    propertyOrdering: ["items"],
  })
  expect(gptelParseSchema("{\"type\":\"object\",\"properties\":{\"ok\":{\"type\":\"boolean\"}}}")).toEqual({
    type: "object",
    properties: { ok: { type: "boolean" } },
    additionalProperties: false,
    required: ["ok"],
    propertyOrdering: ["ok"],
  })
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

test("upstream factory aliases and lookup helpers are available", () => {
  const editor = new Editor()
  const gpt4all = gptelMakeGPT4All(editor, "GPT4All", { models: ["local"] })
  const copilot = gptelMakeGhCopilot(editor, "GH", { key: "token" })
  const tool = gptelMakeTool(editor, {
    name: "lookup",
    description: "search docs",
    function: () => "ok",
  })

  expect(gpt4all.kind).toBe("openai")
  expect(gpt4all.protocol).toBe("http")
  expect(gpt4all.host).toBe("localhost:4891")
  expect(copilot.host).toBe("api.githubcopilot.com")
  expect(gptelGetBackend(editor, "GPT4All")).toBe(gpt4all)
  expect(gptelGetTool(editor, "lookup")).toBe(tool)
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

test("gptel-add-and-open-buffer mirrors Stephen's Emacs helper", async () => {
  const editor = new Editor()
  await install(editor)
  const source = editor.scratch("source.ts", "const answer = 42", "typescript")
  editor.switchToBuffer(source.id)
  await editor.run("gptel-add-and-open-buffer")

  const state = editor.locals.get("gptel-state") as { context: Array<{ type: string; text: string }> }
  expect(state.context).toHaveLength(1)
  expect(state.context[0]).toMatchObject({ type: "buffer", text: "const answer = 42" })
  expect(editor.activeBuffer.name).toStartWith("*ChatGPT*<")
  expect(editor.activeBuffer.mode).toBe("gptel-chat")
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

test("gptel-send converts markdown responses in org-mode buffers", async () => {
  const editor = new Editor()
  await install(editor)
  setCustom("gptel-backend", "Mock")
  setCustom("gptel-model", "mock")
  gptelAddResponseFilter(editor, () => "# Title\n\n```ts\nconst x = 1\n```\n\n* item")
  const buffer = editor.scratch("*gptel-org*", "hello", "org-mode")
  buffer.mode = "org-mode"
  buffer.mark = 0
  buffer.markActive = true
  buffer.point = buffer.text.length
  editor.switchToBuffer(buffer.id)

  await editor.run("gptel-send")

  expect(buffer.text).toContain("* Title")
  expect(buffer.text).toContain("#+begin_src ts")
  expect(buffer.text).toContain("#+end_src")
  expect(buffer.text).toContain("- item")
})

test("gptel org commands save, restore, and scope heading properties", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeOpenAI(editor, "OrgInspect", { endpoint: "http://org.test/v1/chat/completions", models: ["org-model"], defaultModel: "org-model", stream: false })
  setCustom("gptel-backend", "OrgInspect")
  setCustom("gptel-model", "org-model")
  setCustom("gptel-system-message", "Org system\nsecond")
  setCustom("gptel-tools", "lookup")
  setCustom("gptel-temperature", 0.2)
  setCustom("gptel-max-tokens", 321)
  const buffer = editor.scratch("*org-gptel*", "* Work\nUser:\nhello", "org-mode")
  buffer.mode = "org-mode"
  buffer.point = buffer.text.length
  editor.switchToBuffer(buffer.id)

  await editor.run("gptel-org-set-topic", ["work-topic"])
  await editor.run("gptel-org-set-properties")
  expect(buffer.text).toContain(":GPTEL_TOPIC: work-topic")
  expect(buffer.text).toContain(":GPTEL_BACKEND: OrgInspect")
  expect(buffer.text).toContain(":GPTEL_SYSTEM: Org system\\nsecond")

  setCustom("gptel-backend", "Claude")
  setCustom("gptel-model", "changed")
  setCustom("gptel-system-message", "changed")
  setCustom("gptel-tools", "")
  setCustom("gptel-temperature", 0.9)
  setCustom("gptel-max-tokens", 999)
  await editor.run("gptel-restore-state")
  expect(getCustom<string>("gptel-backend")).toBe("OrgInspect")
  expect(getCustom<string>("gptel-model")).toBe("org-model")
  expect(getCustom<string>("gptel-system-message")).toBe("Org system\nsecond")
  expect(getCustom<string>("gptel-tools")).toBe("lookup")
  expect(getCustom<number>("gptel-temperature")).toBe(0.2)
  expect(getCustom<number>("gptel-max-tokens")).toBe(321)

  await editor.run("gptel-inspect-query-json")
  const body = JSON.parse(editor.activeBuffer.text)
  expect(body.messages.at(-1).content).toContain("* Work")
  expect(body.messages.at(-1).content).toContain("hello")
  expect(body.messages.at(-1).content).not.toContain(":PROPERTIES:")
})

test("gptel org branching context keeps only the active heading lineage", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeOpenAI(editor, "OrgBranch", { endpoint: "http://org-branch.test/v1/chat/completions", models: ["org-model"], defaultModel: "org-model", stream: false })
  setCustom("gptel-backend", "OrgBranch")
  setCustom("gptel-model", "org-model")
  setCustom("gptel-org-branching-context", true)
  const buffer = editor.scratch("*org-branch*", [
    "Intro",
    "* Parent",
    "parent body",
    "** One",
    "one body",
    "** Two",
    "two body",
  ].join("\n"), "org-mode")
  buffer.mode = "org-mode"
  buffer.point = buffer.text.length
  editor.switchToBuffer(buffer.id)

  await editor.run("gptel-inspect-query-json")
  const body = JSON.parse(editor.activeBuffer.text)
  const content = body.messages.at(-1).content
  expect(content).toContain("Intro")
  expect(content).toContain("* Parent")
  expect(content).toContain("parent body")
  expect(content).toContain("** Two")
  expect(content).toContain("two body")
  expect(content).not.toContain("** One")
  expect(content).not.toContain("one body")
  setCustom("gptel-org-branching-context", false)
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

test("gptel transient commands expose submenus and apply selected values", async () => {
  const editor = new Editor()
  await install(editor)
  await editor.run("gptel-menu")
  const menuKeys = editor.transient?.definition.groups.flatMap(group => [
    ...(group.infixes ?? []).map(infix => infix.key),
    ...(group.suffixes ?? []).map(suffix => suffix.key),
  ]) ?? []
  expect(menuKeys.filter(key => key === "-S")).toHaveLength(1)
  expect(menuKeys).toContain("-x")

  gptelMakeDirective(editor, { name: "review", prompt: "Review the code for correctness." })
  setCustom("gptel-directives", JSON.stringify({ teach: "Explain this as a teacher." }))
  await editor.run("gptel-system-prompt")
  expect(editor.transient?.definition.name).toBe("gptel-system-prompt")
  const directiveLabels = editor.transient?.definition.groups.flatMap(group => group.suffixes?.map(suffix => suffix.label) ?? []) ?? []
  expect(directiveLabels).toContain("review")
  expect(directiveLabels).toContain("teach")
  await editor.run("gptel-system-prompt-set", ["shell"])
  expect(getCustom<string>("gptel-system-message")).toBe("Reply only with shell commands and no prose.")
  await editor.run("gptel-system-prompt-set", ["review"])
  expect(getCustom<string>("gptel-system-message")).toBe("Review the code for correctness.")
  await editor.run("gptel-system-prompt-set", ["teach"])
  expect(getCustom<string>("gptel-system-message")).toBe("Explain this as a teacher.")

  gptelMakeTool(editor, {
    name: "lookup",
    description: "search docs",
    function: () => "ok",
  })
  await editor.run("gptel-tools")
  expect(editor.transient?.definition.name).toBe("gptel-tools")
  await editor.run("gptel-tools-apply", ["--tool=lookup", "--include-tool-results", "true"])
  expect(getCustom<string>("gptel-tools")).toBe("lookup")
  expect(getCustom<string>("gptel-include-tool-results")).toBe("true")

  const buffer = editor.scratch("*rewrite-menu*", "no region", "text")
  editor.switchToBuffer(buffer.id)
  await editor.run("gptel-rewrite")
  expect(editor.transient?.definition.name).toBe("gptel-rewrite")
  setCustom("gptel-directives", "")
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

test("gptel MCP commands activate and remove server tools", async () => {
  const editor = new Editor()
  await install(editor)
  const lifecycle: string[] = []
  gptelMcpRegisterServer(editor, {
    name: "github",
    status: "disconnected",
    connect: () => { lifecycle.push("connect") },
    disconnect: () => { lifecycle.push("disconnect") },
    tools: [
      {
        name: "search repos",
        description: "Search GitHub repositories.",
        parameters: { type: "object", properties: { query: { type: "string" } } },
        function: args => `repos:${(args as { query?: string }).query ?? ""}`,
      },
    ],
  })

  await editor.run("gptel-mcp-connect", ["github"])
  const st = editor.locals.get("gptel-state") as {
    tools: Map<string, { category?: string; sourceName?: string }>
    mcpServers: Map<string, { status?: string }>
  }
  expect(lifecycle).toEqual(["connect"])
  expect(st.mcpServers.get("github")?.status).toBe("connected")
  expect(st.tools.get("mcp_github_search_repos")?.category).toBe("mcp-github")
  expect(st.tools.get("mcp_github_search_repos")?.sourceName).toBe("search repos")
  expect(getCustom<string>("gptel-tools")).toBe("mcp_github_search_repos")

  await editor.run("gptel-mcp-disconnect", ["github"])
  expect(lifecycle).toEqual(["connect", "disconnect"])
  expect(st.mcpServers.get("github")?.status).toBe("disconnected")
  expect(st.tools.has("mcp_github_search_repos")).toBe(false)
  expect(getCustom<string>("gptel-tools")).toBe("")
})

test("gptel pre and post tool call functions can alter calls and results", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeOpenAI(editor, "ToolHookBackend", { endpoint: "http://tool-hook.test/v1/chat/completions", models: ["tool-model"], defaultModel: "tool-model", stream: false })
  const seen: string[] = []
  gptelMakeTool(editor, {
    name: "lookup",
    description: "Lookup a value.",
    confirm: false,
    include: true,
    parameters: { type: "object", properties: { q: { type: "string" } } },
    function: args => `result:${(args as { q?: string }).q ?? ""}`,
  })
  gptelAddPreToolCallFunction(editor, call => {
    seen.push(`pre:${call.name}`)
    return { ...call, arguments: { q: "rewritten" } }
  })
  gptelAddPostToolCallFunction(editor, (_call, result) => {
    seen.push(`post:${result.content}`)
    return { ...result, content: `${result.content}:filtered` }
  })
  setCustom("gptel-backend", "ToolHookBackend")
  setCustom("gptel-model", "tool-model")
  setCustom("gptel-tools", "lookup")
  setCustom("gptel-use-tools", true)
  setCustom("gptel-include-tool-results", "auto")
  setCustom("gptel-confirm-tool-calls", false)
  setCustom("gptel-stream", false)
  const originalFetch = globalThis.fetch
  let callCount = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    callCount += 1
    if (callCount === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"original\"}" } }],
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    const buffer = editor.scratch("*ChatGPT-tool-hooks*", "User:\nhello", "gptel-chat")
    buffer.point = buffer.text.length
    editor.switchToBuffer(buffer.id)
    await editor.run("gptel-send")

    expect(seen).toEqual(["pre:lookup", "post:result:rewritten"])
    expect(buffer.text).toContain("result:rewritten:filtered")
    expect(buffer.text).not.toContain("result:original")
  } finally {
    globalThis.fetch = originalFetch
    setCustom("gptel-tools", "")
    setCustom("gptel-use-tools", true)
    setCustom("gptel-include-tool-results", "auto")
    setCustom("gptel-confirm-tool-calls", true)
    setCustom("gptel-stream", true)
  }
})

test("gptel-use-context controls request context placement", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeOpenAI(editor, "ContextBackend", { endpoint: "http://context.test/v1/chat/completions", models: ["m"], defaultModel: "m", stream: false })
  setCustom("gptel-backend", "ContextBackend")
  setCustom("gptel-model", "m")
  setCustom("gptel-stream", false)
  const contextBuffer = editor.scratch("*context-source*", "context text", "text")
  contextBuffer.mark = 0
  contextBuffer.markActive = true
  contextBuffer.point = contextBuffer.text.length
  editor.switchToBuffer(contextBuffer.id)
  await editor.run("gptel-add")
  const bodies: any[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")))
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    for (const mode of ["system", "user", "false"]) {
      setCustom("gptel-use-context", mode)
      const buffer = editor.scratch(`*context-${mode}*`, "User:\nhello", "gptel-chat")
      buffer.point = buffer.text.length
      editor.switchToBuffer(buffer.id)
      await editor.run("gptel-send")
    }
    expect(bodies[0].messages.find((message: any) => message.role === "system")?.content).toContain("Additional context:")
    expect(bodies[0].messages.find((message: any) => message.role === "user")?.content).not.toContain("Additional context:")
    expect(bodies[1].messages.find((message: any) => message.role === "system")?.content).not.toContain("Additional context:")
    expect(bodies[1].messages.find((message: any) => message.role === "user")?.content).toContain("Additional context:")
    expect(JSON.stringify(bodies[2].messages)).not.toContain("context text")
  } finally {
    globalThis.fetch = originalFetch
    setCustom("gptel-use-context", "system")
    setCustom("gptel-stream", true)
  }
})

test("gptel-send injects structured output schemas for provider families", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeOpenAI(editor, "SchemaOpenAI", { endpoint: "http://schema.test/openai", models: ["m"], defaultModel: "m", stream: false })
  gptelMakeOpenAIResponses(editor, "SchemaResponses", { endpoint: "http://schema.test/responses", models: ["m"], defaultModel: "m", stream: false })
  gptelMakeAnthropic(editor, "SchemaAnthropic", { endpoint: "http://schema.test/anthropic", models: ["m"], defaultModel: "m", stream: false, key: "anthropic-key" })
  gptelMakeGemini(editor, "SchemaGemini", { endpoint: "http://schema.test/gemini", models: ["m"], defaultModel: "m", stream: false, key: "gemini-key" })
  gptelMakeOllama(editor, "SchemaOllama", { endpoint: "http://schema.test/ollama", models: ["m"], defaultModel: "m", stream: false })
  setCustom("gptel-model", "m")
  setCustom("gptel-stream", false)
  setCustom("gptel-schema", "answer string, score number")
  const bodies: Record<string, any> = {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const key = url.includes("responses") ? "responses"
      : url.includes("anthropic") ? "anthropic"
        : url.includes("gemini") ? "gemini"
          : url.includes("ollama") ? "ollama"
            : "openai"
    bodies[key] = JSON.parse(String(init?.body ?? "{}"))
    if (key === "anthropic") {
      return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "response_json", input: { answer: "ok", score: 1 } }] }), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (key === "gemini") return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "done" }] } }] }), { status: 200, headers: { "content-type": "application/json" } })
    if (key === "ollama") return new Response(JSON.stringify({ message: { content: "done" } }), { status: 200, headers: { "content-type": "application/json" } })
    if (key === "responses") return new Response(JSON.stringify({ output_text: "done" }), { status: 200, headers: { "content-type": "application/json" } })
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    const sentBuffers: BufferModel[] = []
    for (const backend of ["SchemaOpenAI", "SchemaResponses", "SchemaAnthropic", "SchemaGemini", "SchemaOllama"]) {
      setCustom("gptel-backend", backend)
      const buffer = editor.scratch(`*${backend}*`, "User:\nhello", "gptel-chat")
      sentBuffers.push(buffer)
      buffer.point = buffer.text.length
      editor.switchToBuffer(buffer.id)
      await editor.run("gptel-send")
    }
    expect(bodies.openai.response_format.type).toBe("json_schema")
    expect(bodies.openai.response_format.json_schema.schema.required).toEqual(["answer", "score"])
    expect(bodies.responses.text.format.schema.required).toEqual(["answer", "score"])
    expect(bodies.anthropic.tools[0].name).toBe("response_json")
    expect(bodies.anthropic.tool_choice).toEqual({ type: "tool", name: "response_json" })
    expect(bodies.gemini.generationConfig.responseMimeType).toBe("application/json")
    expect(bodies.gemini.generationConfig.responseSchema.required).toEqual(["answer", "score"])
    expect(bodies.ollama.format.required).toEqual(["answer", "score"])
    expect(sentBuffers[2]!.text).toContain("\"answer\": \"ok\"")
    expect(sentBuffers.at(-1)!.text).toContain("done")
  } finally {
    globalThis.fetch = originalFetch
    setCustom("gptel-schema", "")
    setCustom("gptel-stream", true)
  }
})

test("gptel include-reasoning ignore displays reasoning but omits it from follow-up history", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeOpenAI(editor, "ReasoningBackend", { endpoint: "http://reasoning.test/openai", models: ["m"], defaultModel: "m", stream: false })
  setCustom("gptel-backend", "ReasoningBackend")
  setCustom("gptel-model", "m")
  setCustom("gptel-stream", false)
  setCustom("gptel-include-reasoning", "ignore")
  const bodies: any[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")))
    return new Response(JSON.stringify({
      choices: [{ message: { reasoning_content: "private chain", content: "final answer" } }],
    }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    const buffer = editor.scratch("*Reasoning*", "User:\nhello", "gptel-chat")
    buffer.point = buffer.text.length
    editor.switchToBuffer(buffer.id)
    await editor.run("gptel-send")
    expect(buffer.text).toContain("``` reasoning\nprivate chain\n```")
    expect(buffer.text).toContain("final answer")

    buffer.point = buffer.text.length
    buffer.insert("again")
    await editor.run("gptel-send")
    expect(JSON.stringify(bodies[1].messages)).not.toContain("private chain")
    expect(JSON.stringify(bodies[1].messages)).toContain("final answer")
  } finally {
    globalThis.fetch = originalFetch
    setCustom("gptel-include-reasoning", "ignore")
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

test("gptel save and restore state round-trips buffer metadata and variants", async () => {
  const editor = new Editor()
  await install(editor)
  setCustom("gptel-backend", "Mock")
  setCustom("gptel-model", "mock")
  setCustom("gptel-system-message", "Saved system")
  setCustom("gptel-tools", "lookup")
  setCustom("gptel-temperature", 0.25)
  setCustom("gptel-max-tokens", 123)
  const buffer = editor.scratch("*stateful-gptel*", "User:\nhello", "gptel-chat")
  buffer.point = buffer.text.length
  editor.switchToBuffer(buffer.id)
  await editor.run("gptel-send")
  const originalState = editor.locals.get("gptel-state") as {
    lastRequest?: { responseStart: number; responseEnd: number; variants: string[]; variantIndex: number }
  }
  originalState.lastRequest!.variants.push("alternate saved response")
  await editor.run("gptel-save-state")

  expect(buffer.text).toContain("<!-- gptel-state:")
  expect(extractPrompt(buffer).prompt).toBe("")
  setCustom("gptel-backend", "Claude")
  setCustom("gptel-model", "changed")
  setCustom("gptel-system-message", "Changed system")
  setCustom("gptel-tools", "")
  setCustom("gptel-temperature", 0.9)
  setCustom("gptel-max-tokens", 999)
  delete originalState.lastRequest

  await editor.run("gptel-restore-state")
  expect(getCustom<string>("gptel-backend")).toBe("Mock")
  expect(getCustom<string>("gptel-model")).toBe("mock")
  expect(getCustom<string>("gptel-system-message")).toBe("Saved system")
  expect(getCustom<string>("gptel-tools")).toBe("lookup")
  expect(getCustom<number>("gptel-temperature")).toBe(0.25)
  expect(getCustom<number>("gptel-max-tokens")).toBe(123)

  await editor.run("gptel-previous-variant")
  const restoredState = editor.locals.get("gptel-state") as {
    lastRequest: { responseStart: number; responseEnd: number; variantIndex: number }
  }
  expect(buffer.text.slice(restoredState.lastRequest.responseStart, restoredState.lastRequest.responseEnd)).toBe("alternate saved response")
  expect(restoredState.lastRequest.variantIndex).toBe(1)
})

test("gptel inspect-query builds request payload without sending it", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeOpenAI(editor, "InspectBackend", { endpoint: "http://inspect.test/v1/chat/completions", models: ["inspect-model"], defaultModel: "inspect-model", stream: false })
  setCustom("gptel-backend", "InspectBackend")
  setCustom("gptel-model", "inspect-model")
  setCustom("gptel-stream", false)
  const originalFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = (async () => {
    fetchCalled = true
    return new Response("{}")
  }) as unknown as typeof fetch
  try {
    const buffer = editor.scratch("*ChatGPT-inspect-query*", "User:\nhello", "gptel-chat")
    buffer.point = buffer.text.length
    editor.switchToBuffer(buffer.id)
    await editor.run("gptel-inspect-query-json")

    expect(fetchCalled).toBe(false)
    const body = JSON.parse(editor.activeBuffer.text)
    expect(editor.activeBuffer.name).toBe("*gptel-query*")
    expect(body.model).toBe("inspect-model")
    expect(body.messages.at(-1).content).toBe("hello")
  } finally {
    globalThis.fetch = originalFetch
    setCustom("gptel-stream", true)
  }
})

test("upstream gptel-api-key and gptel-system-prompt aliases affect request payloads", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeOpenAI(editor, "CompatBackend", { endpoint: "http://compat.test/v1/chat/completions", models: ["compat-model"], defaultModel: "compat-model", stream: false })
  setCustom("gptel-backend", "CompatBackend")
  setCustom("gptel-model", "compat-model")
  setCustom("gptel-stream", false)
  setCustom("gptel-api-key", "compat-key")
  setCustom("gptel-system-message", "You are a helpful assistant.")
  setCustom("gptel-system-prompt", "Upstream system prompt")
  const buffer = editor.scratch("*ChatGPT-compat*", "User:\nhello", "gptel-chat")
  buffer.point = buffer.text.length
  editor.switchToBuffer(buffer.id)

  await editor.run("gptel-inspect-query")

  const payload = JSON.parse(editor.activeBuffer.text)
  expect(payload.headers.authorization).toBe("Bearer compat-key")
  expect(payload.body.messages[0]).toEqual({ role: "system", content: "Upstream system prompt" })

  setCustom("gptel-api-key", "")
  setCustom("gptel-system-message", "You are a helpful assistant.")
  setCustom("gptel-system-prompt", "You are a helpful assistant.")
  setCustom("gptel-stream", true)
})

test("gptel-cache marks Anthropic system, tool, and message payload sections", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeAnthropic(editor, "CacheClaude", { models: ["claude-test"], defaultModel: "claude-test", stream: false })
  gptelMakeTool(editor, {
    name: "lookup",
    description: "Lookup a value.",
    parameters: { type: "object", properties: { q: { type: "string" } } },
    function: () => "ok",
  })
  setCustom("gptel-backend", "CacheClaude")
  setCustom("gptel-model", "claude-test")
  setCustom("gptel-system-message", "cache me")
  setCustom("gptel-tools", "lookup")
  setCustom("gptel-cache", "system tool message")
  setCustom("gptel-stream", false)

  const buffer = editor.scratch("*ChatGPT-cache-anthropic*", "User:\nhello", "gptel-chat")
  buffer.point = buffer.text.length
  editor.switchToBuffer(buffer.id)
  await editor.run("gptel-inspect-query-json")

  const body = JSON.parse(editor.activeBuffer.text)
  expect(body.system[0].cache_control).toEqual({ type: "ephemeral" })
  expect(body.tools.at(-1).cache_control).toEqual({ type: "ephemeral" })
  expect(body.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" })
  setCustom("gptel-tools", "")
  setCustom("gptel-cache", "")
  setCustom("gptel-stream", true)
})

test("gptel-cache marks Bedrock system and tool payload sections", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeBedrock(editor, "CacheBedrock", { models: ["claude-sonnet-4-5-20250929"], defaultModel: "claude-sonnet-4-5-20250929", stream: false })
  gptelMakeTool(editor, {
    name: "lookup",
    description: "Lookup a value.",
    parameters: { type: "object", properties: { q: { type: "string" } } },
    function: () => "ok",
  })
  setCustom("gptel-backend", "CacheBedrock")
  setCustom("gptel-model", "claude-sonnet-4-5-20250929")
  setCustom("gptel-system-message", "cache bedrock")
  setCustom("gptel-tools", "lookup")
  setCustom("gptel-cache", "system tool")
  setCustom("gptel-stream", false)

  const buffer = editor.scratch("*ChatGPT-cache-bedrock*", "User:\nhello", "gptel-chat")
  buffer.point = buffer.text.length
  editor.switchToBuffer(buffer.id)
  await editor.run("gptel-inspect-query-json")

  const body = JSON.parse(editor.activeBuffer.text)
  expect(body.system.at(-1)).toEqual({ cachePoint: { type: "default" } })
  expect(body.toolConfig.tools.at(-1)).toEqual({ cachePoint: { type: "default" } })
  setCustom("gptel-tools", "")
  setCustom("gptel-cache", "")
  setCustom("gptel-stream", true)
})

test("gptel-log-level records request and response data", async () => {
  const editor = new Editor()
  await install(editor)
  gptelMakeOpenAI(editor, "LogBackend", { endpoint: "http://log.test/v1/chat/completions", models: ["log-model"], defaultModel: "log-model", stream: false })
  setCustom("gptel-backend", "LogBackend")
  setCustom("gptel-model", "log-model")
  setCustom("gptel-stream", false)
  setCustom("gptel-log-level", "debug")
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: "logged" } }],
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch
  try {
    const buffer = editor.scratch("*ChatGPT-log*", "User:\nhello", "gptel-chat")
    buffer.point = buffer.text.length
    editor.switchToBuffer(buffer.id)
    await editor.run("gptel-send")
    await editor.run("gptel-log")

    expect(editor.activeBuffer.name).toBe("*gptel-log*")
    expect(editor.activeBuffer.text).toContain("\"gptel\":\"request headers\"")
    expect(editor.activeBuffer.text).toContain("\"gptel\":\"request body\"")
    expect(editor.activeBuffer.text).toContain("\"gptel\":\"response body\"")
    expect(editor.activeBuffer.text).toContain("logged")
  } finally {
    globalThis.fetch = originalFetch
    setCustom("gptel-log-level", "")
    setCustom("gptel-stream", true)
  }
})

test("oauth login commands save upstream-compatible token files", async () => {
  const home = mkdtempSync(join(tmpdir(), "gptel-home-"))
  const oldHome = process.env.HOME
  process.env.HOME = home
  try {
    const editor = new Editor()
    await install(editor)
    await editor.run("gptel-openai-oauth-login", ["openai-token"])
    await editor.run("gptel-gh-login", ["copilot-token"])
    expect(JSON.parse(readFileSync(join(home, ".emacs.d/.cache/gptel-openai/openai-oauth-token"), "utf8")).token).toBe("openai-token")
    expect(JSON.parse(readFileSync(join(home, ".emacs.d/.cache/copilot-chat/token"), "utf8")).token).toBe("copilot-token")
  } finally {
    if (oldHome == null) delete process.env.HOME
    else process.env.HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  }
})
