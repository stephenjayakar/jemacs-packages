import { basename, resolve } from "node:path"
import type { BufferModel, Editor, PluginContext } from "@jemacs/core"
import { Keymap, createPluginContext, defcustom, defineMode, getCustom } from "@jemacs/core"
import { runJagentAgent, clearJagentAgent, abortJagentAgent, type JagentAgentState } from "./agent"
import { refreshJagentBuffer, jagentFontLock } from "./render"
import { showJagentTerminal } from "./terminal"
import type { JagentCustomProvider, JagentMockResponse, JagentSettings } from "./types"

const JAGENT_MODE = "jagent-mode"
const JAGENT_SESSION_KEY = "jagent-session-key"
const JAGENT_SESSION_CWD = "jagent-session-cwd"

type JagentSessionStore = {
  activeKey?: string
  states: Map<string, JagentAgentState>
}

const stateByEditor = new WeakMap<Editor, JagentSessionStore>()

function cwdFor(editor: Editor): string {
  if (editor.currentBuffer.mode === JAGENT_MODE) {
    const cwd = editor.currentBuffer.locals.get(JAGENT_SESSION_CWD) as string | undefined
    if (cwd) return cwd
  }
  return editor.currentBuffer.directory() ?? process.cwd()
}

function sessionKey(cwd: string): string {
  return resolve(cwd)
}

function storeFor(editor: Editor): JagentSessionStore {
  let store = stateByEditor.get(editor)
  if (!store) {
    store = { states: new Map() }
    stateByEditor.set(editor, store)
  }
  return store
}

function jagentBuffer(editor: Editor, key?: string): BufferModel | undefined {
  return [...editor.buffers.values()].find(buffer =>
    buffer.mode === JAGENT_MODE
    && (key == null || buffer.locals.get(JAGENT_SESSION_KEY) === key))
}

function jagentBufferName(editor: Editor, key: string, cwd: string): string {
  const baseName = basename(cwd) || cwd
  const base = `*Jagent:${baseName}*`
  let name = base
  let index = 2
  while ([...editor.buffers.values()].some(buffer =>
    buffer.name === name && buffer.locals.get(JAGENT_SESSION_KEY) !== key)) {
    name = `*Jagent:${baseName}<${index}>*`
    index++
  }
  return name
}

function recordCustom<T>(name: string): Record<string, T> {
  const value = getCustom<unknown>(name)
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, T>
    : {}
}

function arrayCustom<T>(name: string): T[] {
  const value = getCustom<unknown>(name)
  return Array.isArray(value) ? value as T[] : []
}

function settings(): JagentSettings {
  return {
    provider: (getCustom<string>("jagent-provider") || "auto") as JagentSettings["provider"],
    defaultProvider: (getCustom<string>("jagent-default-provider") || "auto") as JagentSettings["provider"],
    model: getCustom<string>("jagent-model") || "",
    defaultModel: getCustom<string>("jagent-default-model") || "",
    systemPrompt: getCustom<string>("jagent-system-prompt") || "",
    providerSystemPrompts: recordCustom<string>("jagent-provider-system-prompts"),
    modelSystemPrompts: recordCustom<string>("jagent-model-system-prompts"),
    customProviders: recordCustom<JagentCustomProvider>("jagent-custom-providers"),
    mockResponses: arrayCustom<JagentMockResponse>("jagent-mock-responses"),
    apiKeys: {
      gemini: getCustom<string>("jagent-gemini-api-key") || process.env.GEMINI_API_KEY || "",
      openai: getCustom<string>("jagent-openai-api-key")
        || getCustom<string>("jagent-api-key")
        || process.env.OPENAI_API_KEY
        || "",
      anthropic: getCustom<string>("jagent-anthropic-api-key") || process.env.ANTHROPIC_API_KEY || "",
    },
    maxToolRounds: Math.max(1, getCustom<number>("jagent-max-tool-rounds") ?? 8),
    bashTimeoutMs: Math.max(1_000, getCustom<number>("jagent-bash-timeout-ms") ?? 120_000),
  }
}

function ensureState(editor: Editor, cwd = cwdFor(editor)): JagentAgentState {
  const store = storeFor(editor)
  const key = sessionKey(cwd)
  let state = store.states.get(key)
  if (state) return state
  let buffer = jagentBuffer(editor, key)
  if (!buffer) buffer = editor.scratch(jagentBufferName(editor, key, cwd), "", JAGENT_MODE)
  else editor.enterMode(buffer, JAGENT_MODE)
  buffer.readOnly = true
  buffer.locals.set(JAGENT_SESSION_KEY, key)
  buffer.locals.set(JAGENT_SESSION_CWD, key)
  state = {
    buffer,
    messages: [],
    events: [{ type: "session", text: `native agent ready @ ${key}`, at: new Date().toISOString() }],
    cwd: key,
    running: false,
  }
  store.states.set(key, state)
  store.activeKey = key
  refreshJagentBuffer(buffer, state.messages, state.events, settings(), state.cwd, false)
  return state
}

function showJagent(editor: Editor, cwd = cwdFor(editor)): JagentAgentState {
  const state = ensureState(editor, cwd)
  storeFor(editor).activeKey = sessionKey(state.cwd)
  editor.switchToBuffer(state.buffer.id)
  refreshJagentBuffer(state.buffer, state.messages, state.events, settings(), state.cwd, state.running)
  return state
}

function knownSessions(editor: Editor): JagentAgentState[] {
  return [...storeFor(editor).states.values()]
}

function sessionChoice(state: JagentAgentState): string {
  return `${basename(state.cwd) || state.cwd}  ${state.cwd}`
}

async function readSessionDirectory(editor: Editor, initial = cwdFor(editor)): Promise<string | null> {
  return await editor.completingRead("Jagent directory: ", {
    completion: "file",
    initialValue: initial,
    defaultDirectory: initial,
    history: "jagent-directory",
  })
}

function regionText(buffer: BufferModel): string | null {
  if (buffer.mark == null) return null
  const start = Math.min(buffer.mark, buffer.point)
  const end = Math.max(buffer.mark, buffer.point)
  return start === end ? null : buffer.text.slice(start, end)
}

function bufferContext(buffer: BufferModel): string {
  const name = buffer.path ?? buffer.name
  return `Current buffer: ${name}\n\n${buffer.text}`
}

function installMode(): void {
  const map = new Keymap("jagent-mode-map")
  map.bind("i", "jagent-ask")
  map.bind("RET", "jagent-ask")
  map.bind("return", "jagent-ask")
  map.bind("enter", "jagent-ask")
  map.bind("b", "jagent-ask-buffer")
  map.bind("r", "jagent-rerun")
  map.bind("a", "jagent-abort")
  map.bind("c", "jagent-clear")
  map.bind("g", "jagent-redraw")
  map.bind("t", "jagent-terminal")
  map.bind("s", "jagent-session-switch")
  map.bind("n", "jagent-session-new")
  map.bind("q", "jagent-bury")
  defineMode({
    name: JAGENT_MODE,
    parent: "text",
    keymap: map,
    fontLock: jagentFontLock,
  })
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  installMode()

  defcustom("jagent-provider", "string", "auto",
    "Jagent provider override: auto, gemini, openai, anthropic, mock, or a custom provider name.")
  defcustom("jagent-default-provider", "string", "auto",
    "Default Jagent provider when jagent-provider is auto.")
  defcustom("jagent-gemini-api-key", "string", "",
    "Gemini API key; empty falls back to GEMINI_API_KEY.")
  defcustom("jagent-openai-api-key", "string", "",
    "OpenAI API key; empty falls back to OPENAI_API_KEY.")
  defcustom("jagent-anthropic-api-key", "string", "",
    "Anthropic API key; empty falls back to ANTHROPIC_API_KEY.")
  defcustom("jagent-api-key", "string", "",
    "Legacy OpenAI API key fallback for Jagent.")
  defcustom("jagent-model", "string", "",
    "Optional model override for the current Jagent provider.")
  defcustom("jagent-default-model", "string", "",
    "Default Jagent model when jagent-model and provider defaultModel are empty.")
  defcustom("jagent-system-prompt", "string", "",
    "Global Jagent system prompt override. Empty uses the built-in coding-agent prompt.")
  defcustom("jagent-provider-system-prompts", "sexp", {},
    "Map of provider name or kind to Jagent system prompt.")
  defcustom("jagent-model-system-prompts", "sexp", {},
    "Map of model, provider/model, or kind/model to Jagent system prompt.")
  defcustom("jagent-custom-providers", "sexp", {},
    "Map of custom Jagent provider names to provider config objects.")
  defcustom("jagent-mock-responses", "sexp", [],
    "Mock Jagent completions used by provider `mock` or mock custom providers.")
  defcustom("jagent-max-tool-rounds", "number", 8,
    "Maximum model/tool loop rounds per Jagent turn.")
  defcustom("jagent-bash-timeout-ms", "number", 120_000,
    "Maximum time for a Jagent bash tool command running in jterm.")

  ctx.command("jagent", async ({ editor, args }) => {
    const state = showJagent(editor)
    const prompt = args.join(" ") || await editor.prompt("Jagent: ", "", "jagent-prompt")
    if (!prompt) return
    await runJagentAgent(editor, state, settings(), prompt)
  }, "Open Jagent and prompt in the active directory session.")

  ctx.command("jagent-dashboard", ({ editor }) => {
    showJagent(editor)
  }, "Open the native Jagent agent dashboard without prompting.")

  ctx.command("jagent-ask", async ({ editor, args }) => {
    const state = showJagent(editor)
    const prompt = args.join(" ") || await editor.prompt("Jagent: ", "", "jagent-prompt")
    if (!prompt) return
    await runJagentAgent(editor, state, settings(), prompt)
  }, "Ask the native Jagent agent.")

  ctx.command("jagent-ask-buffer", async ({ editor, args }) => {
    const source = editor.currentBuffer.mode === JAGENT_MODE
      ? [...editor.buffers.values()].find(buffer => buffer !== editor.currentBuffer) ?? editor.currentBuffer
      : editor.currentBuffer
    const prompt = args.join(" ") || await editor.prompt(`Jagent about ${source.name}: `, "", "jagent-prompt")
    if (!prompt) return
    const state = showJagent(editor)
    await runJagentAgent(editor, state, settings(), `${prompt}\n\n${bufferContext(source)}`)
  }, "Ask Jagent about the current buffer.")

  ctx.command("jagent-ask-region", async ({ editor, args }) => {
    const region = regionText(editor.currentBuffer)
    if (!region) {
      editor.message("Mark a region first")
      return
    }
    const prompt = args.join(" ") || await editor.prompt("Jagent about region: ", "", "jagent-prompt")
    if (!prompt) return
    const state = showJagent(editor)
    await runJagentAgent(editor, state, settings(), `${prompt}\n\nRegion:\n${region}`)
  }, "Ask Jagent about the active region.")

  ctx.command("jagent-rerun", async ({ editor }) => {
    const state = showJagent(editor)
    if (!state.lastPrompt) {
      editor.message("No previous Jagent prompt")
      return
    }
    await runJagentAgent(editor, state, settings(), state.lastPrompt)
  }, "Re-run the last Jagent prompt.")

  ctx.command("jagent-abort", ({ editor }) => {
    abortJagentAgent(editor, ensureState(editor), settings())
  }, "Abort the current native Jagent turn.")

  ctx.command("jagent-clear", ({ editor }) => {
    clearJagentAgent(editor, ensureState(editor), settings())
  }, "Clear the native Jagent transcript.")

  ctx.command("jagent-redraw", ({ editor }) => {
    const state = showJagent(editor)
    refreshJagentBuffer(state.buffer, state.messages, state.events, settings(), state.cwd, state.running)
  }, "Redraw the native Jagent dashboard.")

  ctx.command("jagent-session-new", async ({ editor, args }) => {
    const cwd = args[0] ?? await readSessionDirectory(editor)
    if (!cwd) return
    showJagent(editor, cwd)
  }, "Create or open a Jagent session rooted at a directory.")

  ctx.command("jagent-session-switch", async ({ editor }) => {
    const sessions = knownSessions(editor)
    if (sessions.length === 0) {
      showJagent(editor)
      return
    }
    const choices = sessions.map(sessionChoice)
    const choice = await editor.completingRead("Jagent session: ", {
      collection: choices,
      initialValue: choices[0],
      history: "jagent-session",
    })
    if (!choice) return
    const index = choices.indexOf(choice)
    const state = sessions[index]
    if (state) showJagent(editor, state.cwd)
  }, "Switch to another Jagent directory session.")

  ctx.command("jagent-terminal", ({ editor }) => {
    if (!showJagentTerminal(editor)) editor.message("Jagent terminal has not run a command yet")
  }, "Show the managed jterm terminal used by Jagent tools.")

  ctx.command("jagent-bury", ({ editor }) => {
    const buffer = jagentBuffer(editor, sessionKey(cwdFor(editor)))
    if (buffer && editor.currentBuffer === buffer) {
      const other = [...editor.buffers.values()].find(candidate => candidate !== buffer)
      if (other) editor.switchToBuffer(other.id)
    }
  }, "Switch away from the Jagent buffer.")

  ctx.key("global", "C-c j", "jagent")
  ctx.key("global", "C-c j d", "jagent-dashboard")
  ctx.key("global", "C-c j a", "jagent-ask")
  ctx.key("global", "C-c j b", "jagent-ask-buffer")
  ctx.key("global", "C-c j r", "jagent-ask-region")
  ctx.key("global", "C-c j s", "jagent-session-switch")
}
