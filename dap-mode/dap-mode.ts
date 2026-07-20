import { basename, dirname, extname, join, relative, resolve } from "node:path"
import {
  BufferModel,
  Keymap,
  createPluginContext,
  defface,
  defcustom,
  defineMode,
  fileExists,
  findWindowLeaf,
  getCustom,
  homedir,
  listWindowLeaves,
  mkdir,
  readFileText,
  writeFileText,
  type Editor,
  type FaceName,
  type GutterDecoration,
  type PluginContext,
  type TextSpan,
  type WindowId,
} from "@jemacs/core"
import { jemacsHome } from "../core-path"
import { findProjectRoot } from "./project-root"
import { dapAdapter, dapTaskProvider, listDapConfigurationProviders } from "./api"
import { installBuiltinDapAdapters } from "./adapters"
import {
  expandLaunchConfiguration,
  parseLaunchJson,
  resolveCompound,
  visibleLaunchItems,
} from "./config"
import { DapSession } from "./session"
import type {
  DapCompoundConfiguration,
  DapContext,
  DapLaunchConfiguration,
  DapSourceBreakpoint,
  DapSessionState,
  DapVariable,
  LaunchJson,
} from "./types"

const BREAKPOINTS_NAME = "*dap-ui-breakpoints*"
const LOCALS_NAME = "*dap-ui-locals*"
const EXPRESSIONS_NAME = "*dap-ui-expressions*"
const SESSIONS_NAME = "*dap-ui-sessions*"
const CONSOLE_NAME = "*dap-ui-repl*"
const LOG_NAME = "*dap-adapter-log*"
const SIDEBAR_MODE = "dap-ui-buffer-mode"
const CONSOLE_MODE = "dap-repl-mode"
const UI_ACTIONS = "dap-ui-actions"
const CONSOLE_PROMPT_START = "dap-console-prompt-start"
const BREAKPOINT_ANCHORS = "dap-breakpoint-anchors"

const BREAKPOINT_FACE = "dap-ui-verified-breakpoint-face" as FaceName
const BREAKPOINT_PENDING_FACE = "dap-ui-pending-breakpoint-face" as FaceName
const EXECUTION_FACE = "dap-ui-marker-face" as FaceName
const EXECUTION_GUTTER_FACE = "dap-ui-compile-errline" as FaceName
const OUTPUT_ERROR_FACE = "dap-ui-error-face" as FaceName

type PersistedProject = {
  breakpoints: DapSourceBreakpoint[]
  watches: string[]
  lastSelection?: string
  recentSelections?: string[]
}
type PersistedState = { version: 1; projects: Record<string, PersistedProject> }
type UiAction =
  | { kind: "header"; section: string }
  | { kind: "frame"; sessionId: string; frameId: number }
  | { kind: "breakpoint"; id: string }
  | { kind: "session"; sessionId: string }
  | { kind: "variable"; sessionId: string; variablesReference: number; name: string }

type EditorState = {
  loaded: boolean
  loadPromise?: Promise<void>
  persisted: PersistedState
  projectRoot?: string
  launch?: LaunchJson
  sessions: DapSession[]
  currentSessionId?: string
  stopAll: boolean
  expanded: Set<string>
  watchResults: Map<string, string>
  consoleEntries: string[]
  savedWindowConfiguration?: ReturnType<Editor["currentWindowConfiguration"]>
  sidebarWindowId?: WindowId
  localsWindowId?: WindowId
  expressionsWindowId?: WindowId
  sessionsWindowId?: WindowId
  consoleWindowId?: WindowId
  mainWindowId?: WindowId
  lastNavigatedFrame?: string
  endingGroup: boolean
  postDebugTasks: string[]
  hookStates: Map<string, DapSessionState>
}

type JtermSession = { pty: { pid: number } }
type JtermModule = {
  sessions: WeakMap<BufferModel, JtermSession>
  spawnSession: (
    editor: Editor,
    buffer: BufferModel,
    argv: string[],
    options: { cwd?: string; env?: Record<string, string>; rows: number; cols: number; label: string },
  ) => Promise<JtermSession>
}
type BreakpointAnchors = { offsets: Map<string, number>; installed: boolean; pending: boolean }

async function loadJterm(): Promise<JtermModule> {
  return await import(join(jemacsHome(), "plugins/jterm/index.ts")) as JtermModule
}

const states = new WeakMap<Editor, EditorState>()

function state(editor: Editor): EditorState {
  let value = states.get(editor)
  if (!value) {
    value = {
      loaded: false,
      persisted: { version: 1, projects: {} },
      sessions: [],
      stopAll: false,
      expanded: new Set(["variables", "watch", "callstack", "breakpoints"]),
      watchResults: new Map(),
      consoleEntries: [],
      endingGroup: false,
      postDebugTasks: [],
      hookStates: new Map(),
    }
    states.set(editor, value)
  }
  return value
}

function currentSession(editor: Editor): DapSession | undefined {
  const st = state(editor)
  const selected = st.currentSessionId ? st.sessions.find(session => session.id === st.currentSessionId) : undefined
  if (selected && selected.state !== "terminated") return selected
  const fallback = st.sessions.find(session => session.state !== "terminated")
  if (fallback) st.currentSessionId = fallback.id
  return fallback
}

function selectCurrentSession(editor: Editor, session: DapSession | undefined): void {
  state(editor).currentSessionId = session?.id
}

function runDapHook(editor: Editor, name: string): void {
  void editor.runHook(name, editor.currentBuffer).catch(error => editor.message(`Error in ${name}: ${String(error)}`))
}

function statePath(): string {
  return getCustom<string>("dap-state-file") ?? join(homedir(), ".jemacs", "dap-state.json")
}

async function loadState(editor: Editor): Promise<void> {
  const st = state(editor)
  if (st.loadPromise) return st.loadPromise
  if (st.loaded) return
  st.loaded = true
  st.loadPromise = (async () => {
    const text = await readFileText(statePath()).catch(() => "")
    if (text) {
      try {
        const parsed = JSON.parse(text) as PersistedState
        if (parsed.version === 1 && parsed.projects && typeof parsed.projects === "object") st.persisted = parsed
      } catch {
        editor.message("Ignoring invalid dap state file")
      }
    }
    await importEmacsBreakpoints(editor)
  })()
  await st.loadPromise
}

function unescapeElispString(value: string): string {
  return value.replace(/\\([\\"])/g, "$1")
}

function emacsBreakpointEntries(serialized: string): Array<{ file: string; body: string }> {
  const entries: Array<{ file: string; body: string }> = []
  const files = /"((?:\\.|[^"\\])+)"\s+\(/g
  for (const match of serialized.matchAll(files)) {
    const open = match.index + match[0].length - 1
    let depth = 1
    let string = false
    let escaped = false
    let end = open + 1
    for (; end < serialized.length && depth > 0; end++) {
      const character = serialized[end]!
      if (string) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === '"') string = false
      } else if (character === '"') string = true
      else if (character === "(") depth++
      else if (character === ")") depth--
    }
    if (depth === 0) entries.push({ file: unescapeElispString(match[1]!), body: serialized.slice(open + 1, end - 1) })
  }
  return entries
}

/** Import GNU dap-mode's persisted breakpoint points without modifying its file. */
async function importEmacsBreakpoints(editor: Editor): Promise<void> {
  const path = getCustom<string>("dap-breakpoints-file") ?? join(homedir(), ".emacs.d", ".dap-breakpoints")
  const serialized = await readFileText(path).catch(() => "")
  if (!serialized) return
  let imported = 0
  for (const entry of emacsBreakpointEntries(serialized)) {
    const file = resolve(entry.file)
    const source = await readFileText(file).catch(() => "")
    if (!source) continue
    const root = await findProjectRoot(file)
    const project = stProject(state(editor), root)
    for (const breakpointMatch of entry.body.matchAll(/\(:point\s+(\d+)([^)]*)\)/g)) {
      const point = Math.max(1, Number(breakpointMatch[1]))
      const line = source.slice(0, point - 1).split("\n").length
      if (project.breakpoints.some(item => resolve(item.path) === file && item.line === line)) continue
      const properties = breakpointMatch[2]!
      const property = (name: string) => properties.match(new RegExp(`:${name}\\s+"((?:\\\\.|[^"\\\\])*)"`))?.[1]
      const enabled = !new RegExp(":enabled\\s+nil\\b").test(properties)
      project.breakpoints.push({
        id: crypto.randomUUID(),
        path: file,
        line,
        enabled,
        condition: property("condition"),
        hitCondition: property("hit-condition"),
        logMessage: property("log-message"),
      })
      imported++
    }
  }
  if (imported) {
    await saveState(editor)
    editor.message(`Imported ${imported} GNU dap-mode breakpoint${imported === 1 ? "" : "s"}`)
  }
}

function stProject(st: EditorState, root: string): PersistedProject {
  return st.persisted.projects[root] ??= { breakpoints: [], watches: [] }
}

function escapeElispString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

async function saveEmacsBreakpoints(editor: Editor): Promise<void> {
  const path = getCustom<string>("dap-breakpoints-file") ?? join(homedir(), ".emacs.d", ".dap-breakpoints")
  const grouped = new Map<string, DapSourceBreakpoint[]>()
  for (const breakpoint of Object.values(state(editor).persisted.projects).flatMap(project => project.breakpoints)) {
    const file = resolve(breakpoint.path)
    const list = grouped.get(file) ?? []
    if (!list.some(item => item.line === breakpoint.line && item.condition === breakpoint.condition && item.hitCondition === breakpoint.hitCondition && item.logMessage === breakpoint.logMessage)) list.push(breakpoint)
    grouped.set(file, list)
  }
  const entries: string[] = []
  for (const [file, breakpoints] of grouped) {
    const source = await readFileText(file).catch(() => "")
    const lines = source.split("\n")
    const points = breakpoints.map(breakpoint => {
      const offset = lines.slice(0, Math.max(0, breakpoint.line - 1)).reduce((total, line) => total + line.length + 1, 0)
      const properties = [
        `:point ${Math.max(1, offset + 1)}`,
        breakpoint.condition ? `:condition "${escapeElispString(breakpoint.condition)}"` : "",
        breakpoint.hitCondition ? `:hit-condition "${escapeElispString(breakpoint.hitCondition)}"` : "",
        breakpoint.logMessage ? `:log-message "${escapeElispString(breakpoint.logMessage)}"` : "",
        !breakpoint.enabled ? ":enabled nil" : "",
      ].filter(Boolean).join(" ")
      return `(${properties})`
    }).join(" ")
    entries.push(`"${escapeElispString(file)}" (${points})`)
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFileText(path, `#s(hash-table data (${entries.join(" ")}))\n`)
}

async function saveState(editor: Editor): Promise<void> {
  const path = statePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFileText(path, JSON.stringify(state(editor).persisted, null, 2) + "\n")
  await saveEmacsBreakpoints(editor)
}

function projectState(editor: Editor, root = state(editor).projectRoot): PersistedProject {
  if (!root) throw new Error("No dap project is active")
  return stProject(state(editor), root)
}

async function contextFor(editor: Editor): Promise<DapContext> {
  await loadState(editor)
  const file = editor.currentBuffer.path
  const root = await findProjectRoot(file ?? join(process.cwd(), ".dap"))
  state(editor).projectRoot = root
  return {
    projectRoot: root,
    workspaceFolders: { [basename(root) || "workspace"]: root },
    file,
    cwd: editor.currentBuffer.directory() ?? root,
    env: name => process.env[name],
    configValues: getCustom<Record<string, string>>("dap-config-values") ?? {},
  }
}

async function readLaunch(editor: Editor, context: DapContext): Promise<LaunchJson | null> {
  const path = join(context.projectRoot, ".vscode", "launch.json")
  if (!await fileExists(path)) {
    state(editor).launch = undefined
    return null
  }
  const launch = parseLaunchJson(await readFileText(path))
  state(editor).launch = launch
  return launch
}

function pythonTestAtPoint(buffer: BufferModel): string | undefined {
  const line = buffer.lineAt(buffer.point)
  let test: string | undefined
  let testIndent = 0
  let enclosingClass: string | undefined
  for (let index = line; index >= 0; index--) {
    const start = buffer.lineStarts[index] ?? 0
    const end = buffer.lineStarts[index + 1] ?? buffer.text.length
    const text = buffer.text.slice(start, end)
    const functionMatch = text.match(/^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/)
    if (!test && functionMatch) {
      test = functionMatch[2]
      testIndent = functionMatch[1]!.length
      continue
    }
    const classMatch = text.match(/^(\s*)class\s+(Test\w*)\b/)
    if (test && classMatch && classMatch[1]!.length < testIndent) { enclosingClass = classMatch[2]; break }
  }
  return test ? `${enclosingClass ? `${enclosingClass}::` : ""}${test}` : undefined
}

function generatedLaunch(context: DapContext, buffer?: BufferModel): LaunchJson {
  if (!context.file) return { version: "0.2.0", configurations: [] }
  const extension = extname(context.file).toLowerCase()
  if (extension === ".py") {
    const test = buffer ? pythonTestAtPoint(buffer) : undefined
    return {
      version: "0.2.0",
      configurations: [
        { name: "Python :: Run file (buffer)", type: "debugpy", request: "launch", program: "${file}", console: "integratedTerminal" },
        { name: "Python :: Run pytest (buffer)", type: "debugpy", request: "launch", module: "pytest", args: ["${file}"], console: "integratedTerminal" },
        { name: "Python :: Run pytest (at point)", type: "debugpy", request: "launch", module: "pytest", args: [test ? `\${file}::${test}` : "${file}"], console: "integratedTerminal" },
        { name: "Python :: Attach to running process", type: "debugpy", request: "attach", processId: "${input:processId}" },
        { name: "Python :: Run file from project directory", type: "debugpy", request: "launch", program: "${file}", cwd: "${workspaceFolder}", console: "integratedTerminal" },
      ],
      inputs: [{ id: "processId", type: "promptString", description: "Python process id" }],
    }
  }
  if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension)) return {
    version: "0.2.0",
    configurations: [{ name: "Node :: Run file (buffer)", type: "pwa-node", request: "launch", program: "${file}", cwd: "${workspaceFolder}", console: "integratedTerminal" }],
  }
  return { version: "0.2.0", configurations: [] }
}

/** Stephen's GNU advice removes missing/out-of-range breakpoint points before every debug run. */
async function pruneInvalidBreakpoints(editor: Editor): Promise<void> {
  let removed = 0
  for (const project of Object.values(state(editor).persisted.projects)) {
    const valid: DapSourceBreakpoint[] = []
    for (const breakpoint of project.breakpoints) {
      const source = await readFileText(breakpoint.path).catch(() => "")
      const lineCount = source ? source.split("\n").length : 0
      if (breakpoint.line >= 1 && breakpoint.line <= lineCount) valid.push(breakpoint)
      else removed++
    }
    project.breakpoints = valid
  }
  if (removed) {
    await saveState(editor)
    editor.message(`Removed ${removed} stale DAP breakpoint${removed === 1 ? "" : "s"}`)
  }
}

function replaceBufferText(buffer: BufferModel, text: string, readOnly = true): void {
  const previous = buffer.readOnly
  buffer.readOnly = false
  buffer.setText(text, false, false)
  buffer.readOnly = readOnly || previous
  buffer.point = Math.min(buffer.point, buffer.text.length)
}

function ensureBreakpointAnchors(editor: Editor, buffer: BufferModel): BreakpointAnchors | undefined {
  if (!buffer.path) return undefined
  const bufferPath = buffer.path
  const existing = buffer.locals.get(BREAKPOINT_ANCHORS) as BreakpointAnchors | undefined
  const anchors = existing ?? { offsets: new Map<string, number>(), installed: false, pending: false }
  if (!existing) buffer.locals.set(BREAKPOINT_ANCHORS, anchors)
  const project = Object.values(state(editor).persisted.projects).find(candidate => candidate.breakpoints.some(item => resolve(item.path) === resolve(bufferPath)))
  for (const breakpoint of project?.breakpoints.filter(item => resolve(item.path) === resolve(bufferPath)) ?? []) {
    if (!anchors.offsets.has(breakpoint.id)) anchors.offsets.set(breakpoint.id, buffer.lineStarts[Math.max(0, breakpoint.line - 1)] ?? buffer.text.length)
  }
  if (!anchors.installed) {
    anchors.installed = true
    buffer.onTextChange = event => {
      const delta = event.text.length - (event.end - event.start)
      for (const [id, offset] of anchors.offsets) {
        if (offset >= event.end) anchors.offsets.set(id, offset + delta)
        else if (offset >= event.start) anchors.offsets.set(id, event.start + event.text.length)
      }
      if (anchors.pending) return
      anchors.pending = true
      queueMicrotask(() => {
        anchors.pending = false
        let changed = false
        for (const candidate of Object.values(state(editor).persisted.projects).flatMap(item => item.breakpoints)) {
          if (resolve(candidate.path) !== resolve(bufferPath)) continue
          const offset = anchors.offsets.get(candidate.id)
          if (offset == null) continue
          const line = buffer.lineAt(Math.min(offset, buffer.text.length)) + 1
          if (line !== candidate.line) { candidate.line = line; candidate.verified = undefined; candidate.message = undefined; changed = true }
        }
        if (changed) {
          void saveState(editor)
          void Promise.all(state(editor).sessions.filter(session => session.state !== "terminated").map(session => session.synchronizeBreakpoints()))
          renderSidebar(editor)
          void editor.changed("dap-breakpoint-moved")
        }
      })
    }
  }
  return anchors
}

function namedBuffer(editor: Editor, name: string): BufferModel | undefined {
  return [...editor.buffers.values()].find(buffer => buffer.name === name)
}

function consoleBuffer(editor: Editor): BufferModel | undefined {
  return namedBuffer(editor, CONSOLE_NAME)
}

function outputBufferName(session: DapSession): string { return `*dap-output: ${session.name}*` }

function renderSessionOutput(editor: Editor, session: DapSession): BufferModel {
  let buffer = namedBuffer(editor, outputBufferName(session))
  if (!buffer) {
    buffer = new BufferModel({ name: outputBufferName(session), kind: "scratch", mode: "dap-output-mode" })
    editor.addBuffer(buffer)
    editor.enterMode(buffer, "dap-output-mode")
  }
  replaceBufferText(buffer, session.output.map(output => `[${output.category}] ${output.text}`).join(""))
  return buffer
}

function actionLine(lines: string[], actions: Array<UiAction | undefined>, text: string, action?: UiAction): void {
  lines.push(text)
  actions.push(action)
}

function renderSidebar(editor: Editor): void {
  const st = state(editor)
  const project = st.projectRoot ? projectState(editor) : { breakpoints: [], watches: [] }
  const render = (name: string, title: string, build: (lines: string[], actions: Array<UiAction | undefined>) => void) => {
    const buffer = namedBuffer(editor, name)
    if (!buffer) return
    const lines = [title]
    const actions: Array<UiAction | undefined> = [undefined]
    build(lines, actions)
    buffer.locals.set(UI_ACTIONS, actions)
    replaceBufferText(buffer, lines.join("\n") + "\n")
  }

  render(LOCALS_NAME, "Locals", (lines, actions) => {
    const stopped = currentSession(editor)
    if (!stopped?.scopes.length) return actionLine(lines, actions, "  Nothing to display...")
    const renderVariables = (variables: DapVariable[], depth: number): void => {
      for (const variable of variables) {
        const key = `${stopped.id}:var:${variable.variablesReference}`
        const expanded = variable.variablesReference > 0 && st.expanded.has(key)
        const marker = variable.variablesReference > 0 ? (expanded ? "▾" : "▸") : " "
        actionLine(lines, actions, `${"  ".repeat(depth)}${marker} ${variable.name}: ${variable.value}`, variable.variablesReference > 0 ? {
          kind: "variable", sessionId: stopped.id, variablesReference: variable.variablesReference, name: variable.name,
        } : undefined)
        if (expanded) renderVariables(stopped.variableChildren.get(variable.variablesReference) ?? [], depth + 1)
      }
    }
    for (const scope of stopped.scopes) {
      actionLine(lines, actions, `▾ ${scope.name}`)
      renderVariables(scope.variables, 1)
    }
  })

  render(EXPRESSIONS_NAME, "Expressions", (lines, actions) => {
    if (!project.watches.length) actionLine(lines, actions, "  Nothing to display...")
    for (const expression of project.watches) actionLine(lines, actions, `${expression}: ${st.watchResults.get(expression) ?? "…"}`)
  })

  render(SESSIONS_NAME, "Debug Sessions", (lines, actions) => {
    if (!st.sessions.length) actionLine(lines, actions, "  Nothing to display...")
    for (const session of st.sessions) {
      const selected = session.id === st.currentSessionId ? "→" : " "
      actionLine(lines, actions, `${selected}${session.state === "stopped" ? "▾" : "▸"} ${session.name}`, { kind: "session", sessionId: session.id })
      for (const thread of session.threads) {
        actionLine(lines, actions, `  ▾ ${thread.name}`)
        if (thread.id !== session.selectedThreadId) continue
        for (const frame of session.frames) {
          const selected = frame.id === session.selectedFrame?.id ? "→" : " "
          actionLine(lines, actions, `    ${selected} ${frame.name} (${frame.source?.name ?? ""}:${frame.line})`, {
            kind: "frame",
            sessionId: session.id,
            frameId: frame.id,
          })
        }
      }
    }
  })

  render(BREAKPOINTS_NAME, "Breakpoints", (lines, actions) => {
    actionLine(lines, actions, "  ☐ Raised Exceptions")
    actionLine(lines, actions, "  ☑ Uncaught Exceptions")
    actionLine(lines, actions, "  ☐ User Uncaught Exceptions")
    for (const breakpoint of project.breakpoints) {
      const glyph = !breakpoint.enabled ? "○" : breakpoint.verified === false ? "◌" : "⬤"
      const root = relative(homedir(), dirname(breakpoint.path)).replaceAll("/", " • ")
      actionLine(lines, actions, `  ${glyph} ${basename(breakpoint.path)}:${breakpoint.line}${root ? ` ${root}` : ""}`, {
        kind: "breakpoint",
        id: breakpoint.id,
      })
    }
  })
  void editor.changed("dap-sidebar")
}

function renderConsole(editor: Editor): void {
  const buffer = consoleBuffer(editor)
  if (!buffer) return
  const st = state(editor)
  const existingStart = buffer.locals.get(CONSOLE_PROMPT_START) as number | undefined
  const input = existingStart == null ? "" : buffer.text.slice(existingStart)
  const parts: string[] = ["DEBUG CONSOLE\n"]
  for (const session of st.sessions) {
    for (const output of session.output) parts.push(st.sessions.length > 1 ? `[${session.name}] ${output.text}` : output.text)
  }
  for (const entry of st.consoleEntries) parts.push(entry.endsWith("\n") ? entry : `${entry}\n`)
  const prefix = parts.join("") + "> "
  replaceBufferText(buffer, prefix + input, false)
  buffer.readOnly = false
  buffer.locals.set(CONSOLE_PROMPT_START, prefix.length)
  buffer.point = buffer.text.length
  void editor.changed("dap-console")
}

async function refreshWatches(editor: Editor): Promise<void> {
  const st = state(editor)
  if (!st.projectRoot) return
  const session = currentSession(editor)
  if (session?.state !== "stopped") {
    st.watchResults.clear()
    renderSidebar(editor)
    return
  }
  for (const expression of projectState(editor).watches) {
    try {
      st.watchResults.set(expression, (await session.evaluate(expression, "watch")).result)
    } catch (error) {
      st.watchResults.set(expression, `<${error instanceof Error ? error.message : String(error)}>`)
    }
  }
  renderSidebar(editor)
}

function uiVisible(editor: Editor): boolean {
  const st = state(editor)
  return Boolean(st.sidebarWindowId && findWindowLeaf(editor.windowLayout, st.sidebarWindowId))
}

function openDebugUi(editor: Editor): void {
  if (uiVisible(editor)) {
    renderSidebar(editor)
    renderConsole(editor)
    return
  }
  const st = state(editor)
  st.savedWindowConfiguration ??= editor.currentWindowConfiguration()
  const sidebarId = editor.selectedWindowId
  const before = new Set(listWindowLeaves(editor.windowLayout).map(leaf => leaf.id))
  editor.splitWindowRight()
  const mainId = listWindowLeaves(editor.windowLayout).find(leaf => !before.has(leaf.id))!.id

  editor.selectWindow(sidebarId)
  const sidebar = editor.scratch(BREAKPOINTS_NAME, "", SIDEBAR_MODE)
  sidebar.readOnly = true
  editor.setSelectedWindowDedicated(true)
  editor.setWindowSplitRatio(sidebarId, (getCustom<number>("dap-sidebar-width") ?? 20) / 100)

  editor.selectWindow(mainId)
  const beforeLocals = new Set(listWindowLeaves(editor.windowLayout).map(leaf => leaf.id))
  editor.splitWindowRight()
  const localsId = listWindowLeaves(editor.windowLayout).find(leaf => !beforeLocals.has(leaf.id))!.id
  editor.selectWindow(localsId)
  const locals = editor.scratch(LOCALS_NAME, "", SIDEBAR_MODE)
  locals.readOnly = true
  editor.setSelectedWindowDedicated(true)
  editor.setWindowSplitRatio(localsId, 0.25)

  const beforeExpressions = new Set(listWindowLeaves(editor.windowLayout).map(leaf => leaf.id))
  editor.splitWindowBelow()
  const expressionsId = listWindowLeaves(editor.windowLayout).find(leaf => !beforeExpressions.has(leaf.id))!.id
  editor.selectWindow(expressionsId)
  const expressions = editor.scratch(EXPRESSIONS_NAME, "", SIDEBAR_MODE)
  expressions.readOnly = true
  editor.setSelectedWindowDedicated(true)

  const beforeSessions = new Set(listWindowLeaves(editor.windowLayout).map(leaf => leaf.id))
  editor.splitWindowBelow()
  const sessionsId = listWindowLeaves(editor.windowLayout).find(leaf => !beforeSessions.has(leaf.id))!.id
  editor.selectWindow(sessionsId)
  const sessions = editor.scratch(SESSIONS_NAME, "", SIDEBAR_MODE)
  sessions.readOnly = true
  editor.setSelectedWindowDedicated(true)

  st.sidebarWindowId = sidebarId
  st.localsWindowId = localsId
  st.expressionsWindowId = expressionsId
  st.sessionsWindowId = sessionsId
  st.mainWindowId = mainId
  editor.selectWindow(mainId)
  renderSidebar(editor)
}

function closeDebugUi(editor: Editor): void {
  const st = state(editor)
  const saved = st.savedWindowConfiguration
  st.savedWindowConfiguration = undefined
  st.sidebarWindowId = undefined
  st.localsWindowId = undefined
  st.expressionsWindowId = undefined
  st.sessionsWindowId = undefined
  st.consoleWindowId = undefined
  st.mainWindowId = undefined
  if (saved) editor.restoreWindowConfiguration(saved)
  for (const name of [BREAKPOINTS_NAME, LOCALS_NAME, EXPRESSIONS_NAME, SESSIONS_NAME, CONSOLE_NAME]) editor.killBuffer(name)
  void editor.changed("dap-ui-close")
}

async function navigateToFrame(editor: Editor, session: DapSession): Promise<void> {
  const frame = session.selectedFrame
  const path = frame?.source?.path
  if (!frame || !path) return
  const key = `${session.id}:${frame.id}:${path}:${frame.line}`
  if (state(editor).lastNavigatedFrame === key) return
  state(editor).lastNavigatedFrame = key
  const mainId = state(editor).mainWindowId
  if (mainId && findWindowLeaf(editor.windowLayout, mainId)) editor.selectWindow(mainId)
  const buffer = await editor.openFile(path)
  buffer.minorModes.add("dap-mode")
  const point = buffer.lineStarts[Math.max(0, frame.line - 1)] ?? 0
  buffer.point = point
  editor.setSelectedWindowPoint(point)
  editor.setSelectedWindowStartLine(Math.max(0, frame.line - 4))
  runDapHook(editor, "dap-position-changed-hook")
  void editor.changed("dap-frame")
}

async function runInTerminal(editor: Editor, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const argv = Array.isArray(args.args) ? args.args.map(String) : []
  if (!argv.length) throw new Error("runInTerminal request did not include args")
  const name = typeof args.title === "string" ? `*${args.title}*` : `*dap-terminal: ${basename(argv[0]!)}*`
  const buffer = new BufferModel({ name, kind: "scratch", mode: "jterm-mode" })
  if (typeof args.cwd === "string") buffer.locals.set("default-directory", args.cwd)
  editor.addBuffer(buffer)
  const jterm = await loadJterm()
  const session = await jterm.spawnSession(editor, buffer, argv, {
    cwd: typeof args.cwd === "string" ? args.cwd : undefined,
    env: args.env && typeof args.env === "object" ? args.env as Record<string, string> : undefined,
    rows: 30,
    cols: 100,
    label: "dap-terminal",
  })
  jterm.sessions.set(buffer, session)
  return { processId: session.pty.pid, shellProcessId: session.pty.pid }
}

function protocolLog(editor: Editor, sessionName: string, line: string): void {
  if (getCustom<boolean>("dap-adapter-log") !== true) return
  let buffer = [...editor.buffers.values()].find(candidate => candidate.name === LOG_NAME)
  if (!buffer) {
    buffer = new BufferModel({ name: LOG_NAME, kind: "scratch", mode: "text" })
    editor.addBuffer(buffer)
  }
  const previous = buffer.readOnly
  buffer.readOnly = false
  buffer.point = buffer.text.length
  buffer.insert(`[${sessionName}] ${line}\n`)
  buffer.readOnly = previous
}

async function handleGroupChanged(editor: Editor, session: DapSession): Promise<void> {
  const st = state(editor)
  if (namedBuffer(editor, outputBufferName(session))) renderSessionOutput(editor, session)
  const previousState = st.hookStates.get(session.id)
  st.hookStates.set(session.id, session.state)
  runDapHook(editor, "dap-session-changed-hook")
  if (session.state === "stopped" && previousState !== "stopped") runDapHook(editor, "dap-stopped-hook")
  if (session.state === "running" && previousState === "stopped") runDapHook(editor, "dap-continue-hook")
  if (session.state === "terminated" && previousState !== "terminated") runDapHook(editor, "dap-terminated-hook")
  if (session.state !== "terminated" && !currentSession(editor)) selectCurrentSession(editor, session)
  if (session.state === "terminated" && st.currentSessionId === session.id) {
    st.currentSessionId = undefined
    currentSession(editor)
  }
  renderSidebar(editor)
  renderConsole(editor)
  if (session.error) editor.message(`${session.name}: ${session.error}`)
  if (session.state === "stopped") {
    if (editor.isMinorModeEnabled("dap-ui-many-windows-mode")) openDebugUi(editor)
    await navigateToFrame(editor, session)
    await refreshWatches(editor)
  }
  if (session.state === "terminated" && st.stopAll && !st.endingGroup && st.sessions.some(candidate => candidate.state !== "terminated")) {
    st.endingGroup = true
    await Promise.all(st.sessions.filter(candidate => candidate.state !== "terminated").map(candidate => candidate.disconnect()))
    st.endingGroup = false
  }
  if (st.sessions.length && st.sessions.every(candidate => candidate.state === "terminated")) {
    const provider = dapTaskProvider()
    if (provider && st.projectRoot) {
      const context = await contextFor(editor)
      for (const task of st.postDebugTasks) await provider.run(task, context).catch(error => editor.message(`postDebugTask ${task}: ${String(error)}`))
    }
    closeDebugUi(editor)
  }
}

async function startConfigurations(
  editor: Editor,
  context: DapContext,
  launch: LaunchJson,
  configurations: DapLaunchConfiguration[],
  selectionName: string,
  stopAll: boolean,
  allowActive = false,
): Promise<void> {
  const st = state(editor)
  if (!allowActive && st.sessions.some(session => session.state !== "terminated")) throw new Error("A dap session group is already active")
  const persisted = projectState(editor, context.projectRoot)
  persisted.lastSelection = selectionName
  persisted.recentSelections = [selectionName, ...(persisted.recentSelections ?? []).filter(name => name !== selectionName)].slice(0, 20)
  await saveState(editor)
  st.stopAll = stopAll
  st.postDebugTasks = []
  st.lastNavigatedFrame = undefined
  const provider = dapTaskProvider()
  const newSessions: DapSession[] = []
  try {
    for (const original of configurations) {
      const config = await expandLaunchConfiguration(editor, original, launch, context)
      if (config.preLaunchTask) {
        if (!provider) throw new Error(`Configuration ${config.name} requires preLaunchTask ${config.preLaunchTask}, but no dap task provider is registered`)
        await provider.run(config.preLaunchTask, context)
      }
      if (config.postDebugTask) {
        if (!provider) throw new Error(`Configuration ${config.name} requires postDebugTask ${config.postDebugTask}, but no dap task provider is registered`)
        st.postDebugTasks.push(config.postDebugTask)
      }
      const adapter = dapAdapter(config.type)
      if (!adapter) throw new Error(`No dap adapter is registered for debug type ${config.type}`)
      const descriptor = await adapter.resolve(config, context)
      const session = new DapSession(config.name, config, descriptor, {
        breakpoints: () => projectState(editor, context.projectRoot).breakpoints,
        breakpointChanged: () => { void saveState(editor); renderSidebar(editor); runDapHook(editor, "dap-breakpoints-changed-hook") },
        runInTerminal: args => runInTerminal(editor, args),
        stackTraceLimit: () => getCustom<number>("dap-stack-trace-limit") ?? 100,
        executed: () => runDapHook(editor, "dap-executed-hook"),
        changed: changedSession => { void handleGroupChanged(editor, changedSession) },
      }, line => protocolLog(editor, config.name, line))
      st.sessions.push(session)
      newSessions.push(session)
      if (!currentSession(editor)) selectCurrentSession(editor, session)
      runDapHook(editor, "dap-session-created-hook")
    }
    renderSidebar(editor)
    await Promise.all(newSessions.map(session => session.start()))
  } catch (error) {
    await Promise.all(newSessions.map(session => session.disconnect().catch(() => {})))
    st.sessions = st.sessions.filter(session => !newSessions.includes(session))
    if (!st.sessions.length) closeDebugUi(editor)
    throw error
  }
}

async function availableLaunch(editor: Editor): Promise<{ context: DapContext; launch: LaunchJson; names: string[] }> {
  const context = await contextFor(editor)
  await pruneInvalidBreakpoints(editor)
  const fileLaunch = await readLaunch(editor, context)
  const providerConfigs = (await Promise.all(listDapConfigurationProviders().map(provider => provider(context)))).flat()
    .map(config => ({ ...config, name: `provider:${config.name}` }))
  const generated = generatedLaunch(context, editor.currentBuffer)
  const launch: LaunchJson = fileLaunch
    ? { ...fileLaunch, configurations: [...fileLaunch.configurations, ...providerConfigs] }
    : { ...generated, configurations: [...generated.configurations, ...providerConfigs] }
  const names = visibleLaunchItems(launch).map(item => item.name)
  return { context, launch, names }
}

async function debugSelection(editor: Editor, requested?: string): Promise<void> {
  const { context, launch, names } = await availableLaunch(editor)
  if (!names.length) throw new Error("No launch.json configurations and no generated configuration for this buffer")
  const selection = requested ?? await editor.completingRead("Debug configuration: ", {
    collection: names,
    initialValue: projectState(editor, context.projectRoot).lastSelection,
    history: "dap-configuration",
  })
  if (!selection) return
  const compound = launch.compounds?.find(item => item.name === selection)
  if (compound) {
    const resolved = resolveCompound(launch, selection)
    await startConfigurations(editor, context, launch, resolved.configurations, selection, compound.stopAll === true)
    return
  }
  const config = launch.configurations.find(item => item.name === selection)
  if (!config) throw new Error(`No debug configuration named ${selection}`)
  await startConfigurations(editor, context, launch, [config], selection, false)
}

async function debugAttach(editor: Editor): Promise<void> {
  const { context, launch } = await availableLaunch(editor)
  const configurations = launch.configurations.filter(config => config.request === "attach" && config.presentation?.hidden !== true)
  if (!configurations.length) throw new Error("launch.json has no visible attach configurations")
  const selection = await editor.completingRead("Attach configuration: ", {
    collection: configurations.map(config => config.name),
    history: "dap-attach-configuration",
  })
  if (!selection) return
  const config = configurations.find(candidate => candidate.name === selection)!
  await startConfigurations(editor, context, launch, [config], selection, false)
}

function sourceOverlay(editor: Editor, buffer: BufferModel): TextSpan[] {
  const session = currentSession(editor)
  const frame = session?.selectedFrame
  if (session?.state !== "stopped" || !frame?.source?.path || !buffer.path) return []
  if (resolve(frame.source.path) !== resolve(buffer.path)) return []
  const start = buffer.lineStarts[Math.max(0, frame.line - 1)] ?? 0
  const end = buffer.lineStarts[frame.line] ?? buffer.text.length
  return end > start ? [{ start, end, face: EXECUTION_FACE }] : []
}

function gutterDecorations(editor: Editor, buffer: BufferModel): GutterDecoration[] {
  if (!buffer.path) return []
  ensureBreakpointAnchors(editor, buffer)
  const path = resolve(buffer.path)
  const decorations: GutterDecoration[] = []
  for (const project of Object.values(state(editor).persisted.projects)) {
    for (const breakpoint of project.breakpoints.filter(item => resolve(item.path) === path)) {
      decorations.push({
        line: breakpoint.line,
        glyph: !breakpoint.enabled ? "×" : breakpoint.condition ? "◆" : breakpoint.logMessage ? "◇" : breakpoint.verified === false ? "○" : "●",
        face: breakpoint.verified === false ? BREAKPOINT_PENDING_FACE : BREAKPOINT_FACE,
        priority: 10,
        title: breakpoint.message,
      })
    }
  }
  const session = currentSession(editor)
  const frame = session?.selectedFrame
  if (session?.state === "stopped" && frame?.source?.path && resolve(frame.source.path) === path) {
    decorations.push({ line: frame.line, glyph: "▶", face: EXECUTION_GUTTER_FACE, priority: 100 })
  }
  return decorations
}

async function toggleBreakpoint(editor: Editor, buffer: BufferModel): Promise<void> {
  if (!buffer.path) throw new Error("Breakpoints require a file buffer")
  const context = await contextFor(editor)
  const project = projectState(editor, context.projectRoot)
  const anchors = ensureBreakpointAnchors(editor, buffer)
  const path = resolve(buffer.path)
  const line = buffer.lineAt(buffer.point) + 1
  const index = project.breakpoints.findIndex(item => resolve(item.path) === path && item.line === line)
  if (index >= 0) {
    anchors?.offsets.delete(project.breakpoints[index]!.id)
    project.breakpoints.splice(index, 1)
  } else {
    const breakpoint = { id: crypto.randomUUID(), path, line, enabled: true }
    project.breakpoints.push(breakpoint)
    anchors?.offsets.set(breakpoint.id, buffer.lineStarts[Math.max(0, line - 1)] ?? buffer.text.length)
  }
  buffer.minorModes.add("dap-mode")
  await saveState(editor)
  await Promise.all(state(editor).sessions.filter(session => session.state !== "terminated").map(session => session.synchronizeBreakpoints()))
  renderSidebar(editor)
  runDapHook(editor, "dap-breakpoints-changed-hook")
  void editor.changed("dap-breakpoint")
}

async function breakpointAtPoint(editor: Editor, buffer: BufferModel): Promise<DapSourceBreakpoint> {
  if (!buffer.path) throw new Error("Breakpoints require a file buffer")
  const context = await contextFor(editor)
  const project = projectState(editor, context.projectRoot)
  const path = resolve(buffer.path)
  const line = buffer.lineAt(buffer.point) + 1
  let breakpoint = project.breakpoints.find(item => resolve(item.path) === path && item.line === line)
  if (!breakpoint) {
    breakpoint = { id: crypto.randomUUID(), path, line, enabled: true }
    project.breakpoints.push(breakpoint)
  }
  return breakpoint
}

function selectedUiBreakpoint(editor: Editor, buffer: BufferModel): DapSourceBreakpoint | undefined {
  const actions = buffer.locals.get(UI_ACTIONS) as Array<UiAction | undefined> | undefined
  const action = actions?.[buffer.lineAt(buffer.point)]
  if (action?.kind !== "breakpoint") return undefined
  return Object.values(state(editor).persisted.projects)
    .flatMap(project => project.breakpoints)
    .find(item => item.id === action.id)
}

async function resynchronizeBreakpoints(editor: Editor): Promise<void> {
  await saveState(editor)
  await Promise.all(state(editor).sessions.filter(session => session.state !== "terminated").map(session => session.synchronizeBreakpoints()))
  renderSidebar(editor)
  runDapHook(editor, "dap-breakpoints-changed-hook")
  void editor.changed("dap-breakpoint-update")
}

async function evaluateConsole(editor: Editor): Promise<void> {
  const buffer = consoleBuffer(editor)
  const session = currentSession(editor)
  if (!buffer || session?.state !== "stopped") {
    editor.message("No stopped debug session")
    return
  }
  const start = buffer.locals.get(CONSOLE_PROMPT_START) as number | undefined
  const expression = start == null ? "" : buffer.text.slice(start).trim()
  if (!expression) return
  const result = await session.evaluate(expression)
  state(editor).consoleEntries.push(`> ${expression}\n${result.result}`)
  buffer.locals.set(CONSOLE_PROMPT_START, buffer.text.length)
  renderConsole(editor)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("dap-state-file", "string", join(homedir(), ".jemacs", "dap-state.json"), "Persistent dap breakpoints, watches, and last configurations.", "dap")
  defcustom("dap-breakpoints-file", "string", join(homedir(), ".emacs.d", ".dap-breakpoints"), "GNU dap-mode breakpoint file imported by Jemacs.", "dap")
  defcustom("dap-python-debugger", "string", "debugpy", "Python debugger backend, matching Stephen's GNU Emacs config.", "dap-python")
  defcustom("dap-python-executable", "string", "python", "Python executable used by dap-python.", "dap-python")
  defcustom("dap-node-command", "string", "node", "Node executable used to start js-debug.", "dap")
  defcustom("dap-node-adapter-path", "string", "", "Optional path to js-debug/src/dapDebugServer.js.", "dap")
  defcustom("dap-adapter-log", "boolean", false, "Log DAP messages to *dap-adapter-log*.", "dap")
  defcustom("dap-sidebar-width", "number", 20, "DAP side-window width as a percentage.", "dap")
  defcustom("dap-console-height", "number", 25, "Debug Console height as a percentage.", "dap")
  defcustom("dap-config-values", "sexp", {} as Record<string, string>, "Values used by launch.json ${config:NAME} substitutions.", "dap")
  defcustom("dap-debug-restart-keep-session", "boolean", true, "Keep the previous DAP session visible when dap-debug-restart relaunches it.", "dap")
  defcustom("dap-stack-trace-limit", "number", 100, "Maximum number of stack frames requested for a stopped DAP thread.", "dap")
  defcustom("dap-auto-configure-features", "sexp", ["sessions", "locals", "breakpoints", "expressions", "controls", "tooltip"], "DAP UI features enabled by dap-auto-configure-mode.", "dap")

  ctx.hook("after-save-hook", async ({ editor: ed, buffer }) => {
    if (buffer.path) { ensureBreakpointAnchors(ed, buffer); await saveState(ed) }
  })
  ctx.hook("kill-buffer-hook", async ({ editor: ed, buffer }) => {
    if (buffer.path) await saveState(ed)
  })

  defface(BREAKPOINT_FACE, { fg: "#f14c4c", bold: true }, "Verified breakpoint marker.", "dap")
  defface(BREAKPOINT_PENDING_FACE, { fg: "#c5c5c5" }, "Unverified breakpoint marker.", "dap")
  defface(EXECUTION_FACE, { bg: "#3a3d41" }, "Current debugger execution line.", "dap")
  defface(EXECUTION_GUTTER_FACE, { fg: "#ffcc66", bold: true }, "Current debugger execution marker.", "dap")
  defface(OUTPUT_ERROR_FACE, { fg: "#f14c4c" }, "Debugger error output.", "dap")

  const disposeAdapters = installBuiltinDapAdapters()
  ctx.onDispose(disposeAdapters)
  const disposeOverlay = editor.addOverlaySource(buffer => sourceOverlay(editor, buffer))
  ctx.onDispose(disposeOverlay)
  const disposeGutter = editor.addGutterDecorationSource(buffer => gutterDecorations(editor, buffer))
  ctx.onDispose(disposeGutter)

  ctx.minorMode({ name: "dap-mode", lighter: " DAP", global: true, keymap: new Keymap("dap-mode-map") })
  ctx.minorMode({ name: "dap-ui-mode", lighter: "", global: true, keymap: new Keymap("dap-ui-mode-map") })
  ctx.minorMode({ name: "dap-ui-many-windows-mode", lighter: "", global: true })
  ctx.minorMode({ name: "dap-ui-controls-mode", lighter: "", global: true })
  ctx.minorMode({ name: "dap-tooltip-mode", lighter: "", global: true })
  ctx.minorMode({
    name: "dap-auto-configure-mode",
    lighter: "",
    global: true,
    onEnable(ed) {
      const features = getCustom<string[]>("dap-auto-configure-features") ?? ["sessions", "locals", "breakpoints", "expressions", "controls", "tooltip"]
      const modes = ["dap-mode", "dap-ui-mode"]
      if (features.some(feature => ["sessions", "locals", "breakpoints", "expressions"].includes(feature))) modes.push("dap-ui-many-windows-mode")
      if (features.includes("controls")) modes.push("dap-ui-controls-mode")
      if (features.includes("tooltip")) modes.push("dap-tooltip-mode")
      for (const mode of modes) {
        if (!ed.isMinorModeEnabled(mode)) ed.enableMinorMode(mode)
      }
    },
    onDisable(ed) {
      for (const mode of ["dap-ui-many-windows-mode", "dap-ui-controls-mode", "dap-tooltip-mode", "dap-ui-mode", "dap-mode"]) {
        if (ed.isMinorModeEnabled(mode)) ed.disableMinorMode(mode)
      }
      if (uiVisible(ed)) closeDebugUi(ed)
    },
  })

  const sidebarMap = new Keymap("dap-ui-mode-map")
  sidebarMap.bind("return", "dap-ui-activate")
  sidebarMap.bind("RET", "dap-ui-activate")
  sidebarMap.bind("q", "dap-ui-hide-many-windows")
  sidebarMap.bind("SPC", "dap-breakpoint-toggle-enabled")
  sidebarMap.bind("d", "dap-breakpoint-delete")
  defineMode({ name: SIDEBAR_MODE, parent: "text", keymap: sidebarMap, onEnter: buffer => { buffer.readOnly = true } })
  defineMode({ name: "dap-output-mode", parent: "text" })

  const consoleMap = new Keymap("dap-repl-mode-map")
  consoleMap.bind("return", "dap-console-submit")
  consoleMap.bind("RET", "dap-console-submit")
  defineMode({ name: CONSOLE_MODE, parent: "text", keymap: consoleMap })

  const command = (name: string, fn: Parameters<PluginContext["command"]>[1], doc: string) => ctx.command(name, fn, doc)
  for (const mode of ["dap-mode", "dap-ui-mode", "dap-ui-many-windows-mode", "dap-ui-controls-mode", "dap-tooltip-mode", "dap-auto-configure-mode"]) {
    command(mode, ({ editor: ed, prefixArgument }) => {
      if (prefixArgument === 1) ed.enableMinorMode(mode)
      else if (prefixArgument === 0 || prefixArgument === -1) ed.disableMinorMode(mode)
      else ed.toggleMinorMode(mode)
    }, `Toggle ${mode}.`)
  }
  command("dap-turn-on-dap-mode", ({ editor: ed }) => {
    if (!ed.isMinorModeEnabled("dap-mode")) ed.enableMinorMode("dap-mode")
  }, "Turn on dap-mode.")
  command("dap-debug", async ({ editor }) => {
    try { await debugSelection(editor) } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Select and start a VS Code launch.json configuration or compound.")
  command("dap-debug-last", async ({ editor }) => {
    try {
      const context = await contextFor(editor)
      const last = projectState(editor, context.projectRoot).lastSelection
      if (!last) { editor.message("No previous dap configuration for this project"); return }
      await debugSelection(editor, last)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Reload launch.json and start the last dap configuration.")
  command("dap-debug-recent", async ({ editor }) => {
    try {
      const context = await contextFor(editor)
      const recent = projectState(editor, context.projectRoot).recentSelections ?? []
      if (!recent.length) { editor.message("No recent dap configurations for this project"); return }
      const selection = await editor.completingRead("Recent dap configuration: ", { collection: recent, history: "dap-recent-configuration" })
      if (selection) await debugSelection(editor, selection)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Select and restart a recently used debug configuration.")
  command("dap-python-debug-test-at-point", async ({ editor }) => {
    try { await debugSelection(editor, "Python :: Run pytest (at point)") }
    catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Debug the pytest test at point.")
  command("dap-python--debug-test-at-point", async ({ editor }) => {
    try { await debugSelection(editor, "Python :: Run pytest (at point)") }
    catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Compatibility alias for dap-python-debug-test-at-point.")
  command("dap-start-or-continue", async ({ editor }) => {
    const selected = currentSession(editor)
    if (selected?.state === "stopped") {
      try { await selected.continue() } catch (error) { editor.message(String(error)) }
      return
    }
    if (state(editor).sessions.some(session => session.state !== "terminated")) {
      editor.message("Debug session is already running")
      return
    }
    try {
      const context = await contextFor(editor)
      const last = projectState(editor, context.projectRoot).lastSelection
      await debugSelection(editor, last)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Start the last configuration, select one when needed, or continue a stopped session.")
  command("dap-attach", async ({ editor }) => {
    try { await debugAttach(editor) } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Select and start an attach configuration from launch.json.")
  command("dap-create-launch-json", async ({ editor }) => {
    try {
      const context = await contextFor(editor)
      const launch = generatedLaunch(context, editor.currentBuffer)
      if (!launch.configurations.length) throw new Error("Open a Python, JavaScript, or TypeScript file first")
      const path = join(context.projectRoot, ".vscode", "launch.json")
      if (await fileExists(path)) throw new Error(`${path} already exists`)
      const answer = await editor.prompt(`Create ${path}? (y or n) `)
      if (answer?.toLowerCase() !== "y") return
      await mkdir(dirname(path), { recursive: true })
      await writeFileText(path, JSON.stringify(launch, null, 2) + "\n")
      await editor.openFile(path)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Create a minimal .vscode/launch.json for the current file.")
  command("dap-breakpoint-toggle", async ({ editor, buffer }) => {
    try { await toggleBreakpoint(editor, buffer) } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Toggle a source breakpoint on the current line.")
  command("dap-breakpoint-add", async ({ editor, buffer }) => {
    try {
      const breakpoint = await breakpointAtPoint(editor, buffer)
      await resynchronizeBreakpoints(editor)
      editor.message(`Breakpoint added at ${basename(breakpoint.path)}:${breakpoint.line}`)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Add a source breakpoint on the current line.")
  command("dap-breakpoint-condition", async ({ editor, buffer }) => {
    try {
      const breakpoint = await breakpointAtPoint(editor, buffer)
      const value = await editor.prompt("Breakpoint condition: ", breakpoint.condition ?? "", "dap-condition")
      if (value == null) return
      breakpoint.condition = value || undefined
      await saveState(editor)
      await Promise.all(state(editor).sessions.map(session => session.synchronizeBreakpoints()))
      renderSidebar(editor)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Set the condition for the breakpoint on the current line.")
  command("dap-breakpoint-hit-condition", async ({ editor, buffer }) => {
    try {
      const breakpoint = selectedUiBreakpoint(editor, buffer) ?? await breakpointAtPoint(editor, buffer)
      const value = await editor.prompt("Breakpoint hit condition: ", breakpoint.hitCondition ?? "", "dap-hit-condition")
      if (value == null) return
      breakpoint.hitCondition = value || undefined
      await resynchronizeBreakpoints(editor)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Set the hit condition for the selected or current-line breakpoint.")
  command("dap-breakpoint-toggle-enabled", async ({ editor, buffer }) => {
    try {
      const breakpoint = selectedUiBreakpoint(editor, buffer) ?? await breakpointAtPoint(editor, buffer)
      breakpoint.enabled = !breakpoint.enabled
      await resynchronizeBreakpoints(editor)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Enable or disable the selected or current-line breakpoint.")
  command("dap-breakpoint-delete", async ({ editor, buffer }) => {
    let breakpoint = selectedUiBreakpoint(editor, buffer)
    if (!breakpoint && buffer.path) {
      const context = await contextFor(editor)
      const line = buffer.lineAt(buffer.point) + 1
      breakpoint = projectState(editor, context.projectRoot).breakpoints.find(item => resolve(item.path) === resolve(buffer.path!) && item.line === line)
    }
    if (!breakpoint) { editor.message("No breakpoint found"); return }
    for (const project of Object.values(state(editor).persisted.projects)) {
      const index = project.breakpoints.findIndex(item => item.id === breakpoint.id)
      if (index >= 0) project.breakpoints.splice(index, 1)
    }
    for (const buffer of editor.buffers.values()) {
      const anchors = buffer.locals.get(BREAKPOINT_ANCHORS) as BreakpointAnchors | undefined
      anchors?.offsets.delete(breakpoint.id)
    }
    await resynchronizeBreakpoints(editor)
  }, "Delete the breakpoint selected in the dap sidebar.")
  command("dap-breakpoint-delete-all", async ({ editor }) => {
    for (const project of Object.values(state(editor).persisted.projects)) project.breakpoints = []
    for (const buffer of editor.buffers.values()) {
      const anchors = buffer.locals.get(BREAKPOINT_ANCHORS) as BreakpointAnchors | undefined
      anchors?.offsets.clear()
    }
    await resynchronizeBreakpoints(editor)
  }, "Delete all DAP breakpoints.")
  command("dap-breakpoint-log-message", async ({ editor, buffer }) => {
    try {
      const breakpoint = await breakpointAtPoint(editor, buffer)
      const value = await editor.prompt("Log message: ", breakpoint.logMessage ?? "", "dap-breakpoint-log-message")
      if (value == null) return
      breakpoint.logMessage = value || undefined
      await saveState(editor)
      await Promise.all(state(editor).sessions.map(session => session.synchronizeBreakpoints()))
      renderSidebar(editor)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Set a log message for the breakpoint on the current line.")
  command("dap-mode-mouse-set-clear-breakpoint", async ({ editor, buffer }) => {
    try { await toggleBreakpoint(editor, buffer) } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Set or clear the breakpoint at the mouse/current point.")
  command("dap-ui-breakpoints-goto", async ({ editor, buffer }) => {
    const breakpoint = selectedUiBreakpoint(editor, buffer)
    if (!breakpoint) { editor.message("No breakpoint selected"); return }
    const target = await editor.openFile(breakpoint.path)
    target.point = target.lineStarts[Math.max(0, breakpoint.line - 1)] ?? 0
    editor.setSelectedWindowPoint(target.point)
  }, "Go to the selected breakpoint.")
  command("dap-ui-breakpoints-delete", async ({ editor, buffer }) => { await editor.run("dap-breakpoint-delete", [], null) }, "Delete the selected breakpoint.")
  command("dap-ui-breakpoints-delete-selected", async ({ editor, buffer }) => { await editor.run("dap-breakpoint-delete", [], null) }, "Delete the selected breakpoint.")
  command("dap-ui-breakpoints-browse", ({ editor }) => { openDebugUi(editor); const id = state(editor).sidebarWindowId; if (id) editor.selectWindow(id) }, "Browse DAP breakpoints.")
  command("dap-ui-breakpoints-list", ({ editor }) => { openDebugUi(editor); const id = state(editor).sidebarWindowId; if (id) editor.selectWindow(id) }, "List DAP breakpoints.")
  command("dap-ui-expressions-add", async ({ editor }) => {
    try {
      const context = await contextFor(editor)
      const expression = await editor.prompt("Watch expression: ", "", "dap-watch")
      if (!expression) return
      const watches = projectState(editor, context.projectRoot).watches
      if (!watches.includes(expression)) watches.push(expression)
      await saveState(editor)
      await refreshWatches(editor)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Add a watch expression for the current project.")
  command("dap-ui-expressions-add-prompt", async ({ editor }) => { await editor.run("dap-ui-expressions-add") }, "Prompt for and add a watch expression.")
  command("dap-ui-expressions-refresh", async ({ editor }) => { await refreshWatches(editor) }, "Refresh DAP watch expressions.")
  command("dap-ui-expressions-remove", async ({ editor, buffer }) => {
    const context = await contextFor(editor)
    const expression = buffer.lineAt(buffer.point) === 0 ? undefined : buffer.text.split("\n")[buffer.lineAt(buffer.point)]?.trim()
    if (!expression) { editor.message("No expression selected"); return }
    const watches = projectState(editor, context.projectRoot).watches
    const index = watches.indexOf(expression)
    if (index >= 0) { watches.splice(index, 1); await saveState(editor); renderSidebar(editor) }
  }, "Remove the selected watch expression.")
  command("dap-ui-eval-in-buffer", async ({ editor, buffer }) => {
    const session = currentSession(editor)
    if (session?.state !== "stopped") { editor.message("No stopped debug session"); return }
    const expression = buffer.selectedText().trim()
    if (!expression) { editor.message("No expression selected"); return }
    try {
      const result = await session.evaluate(expression)
      const target = new BufferModel({ name: "*dap-ui-eval*", kind: "scratch", mode: "text", text: result.result })
      editor.addBuffer(target)
      editor.displayBufferInOtherWindow(target.id, { select: true })
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Evaluate the selected expression in a buffer.")
  command("dap-ui-eval-variable-in-buffer", async ({ editor, buffer }) => { await editor.run("dap-ui-eval-in-buffer", [], null) }, "Evaluate the selected variable in a buffer.")
  command("dap-ui-set-variable", async ({ editor, buffer }) => {
    const action = (buffer.locals.get(UI_ACTIONS) as Array<UiAction | undefined> | undefined)?.[buffer.lineAt(buffer.point)]
    if (action?.kind !== "variable") { editor.message("No expandable variable selected"); return }
    const session = state(editor).sessions.find(candidate => candidate.id === action.sessionId)
    if (!session) return
    const value = await editor.prompt(`Set ${action.name}: `, "", "dap-set-variable")
    if (value == null) return
    try {
      await session.setVariable(action.variablesReference, action.name, value)
      await session.variables(action.variablesReference)
      renderSidebar(editor)
    } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Set the selected DAP variable.")
  command("dap-tooltip-at-point", async ({ editor, buffer }) => {
    const left = buffer.text.slice(0, buffer.point).match(/[A-Za-z_$][\w.$]*$/)?.[0] ?? ""
    const right = buffer.text.slice(buffer.point).match(/^[\w.$]*/)?.[0] ?? ""
    const expression = left + right
    const session = currentSession(editor)
    if (!expression || session?.state !== "stopped") { editor.message("No stopped debug session or expression at point"); return }
    try { editor.message((await session.evaluate(expression, "watch")).result) } catch (error) { editor.message(String(error)) }
  }, "Evaluate the expression at point and show it in the echo area.")
  command("dap-tooltip-mouse-motion", async ({ editor, buffer }) => { await editor.run("dap-tooltip-at-point", [], null) }, "Evaluate the expression under the mouse/current point.")
  command("dap-go-to-output-buffer", ({ editor }) => {
    const session = currentSession(editor)
    if (!session) { editor.message("No current debug session"); return }
    const buffer = renderSessionOutput(editor, session)
    editor.displayBufferInOtherWindow(buffer.id, { select: true })
  }, "Go to the current session's output buffer.")
  command("dap-ui-repl-company", ({ editor }) => { editor.message("DAP REPL completion is adapter-dependent; use dap-ui-repl") }, "Enable DAP REPL completion support.")
  command("dap-debug-edit-template", async ({ editor }) => {
    const context = await contextFor(editor)
    const path = join(context.projectRoot, ".vscode", "launch.json")
    if (!await fileExists(path)) { editor.message("No launch.json template exists"); return }
    await editor.openFile(path)
  }, "Edit the current project's DAP launch template.")
  command("dap-ui-loaded-sources", ({ editor }) => {
    const sources = new Set<string>()
    for (const session of state(editor).sessions) for (const frame of session.frames) if (frame.source?.path) sources.add(frame.source.path)
    editor.message(sources.size ? [...sources].join(", ") : "No loaded sources")
  }, "Show sources reported by the current DAP sessions.")
  command("dap-eval", async ({ editor }) => {
    const session = currentSession(editor)
    if (session?.state !== "stopped") { editor.message("No stopped debug session"); return }
    const expression = await editor.prompt("Evaluate: ", "", "dap-eval")
    if (!expression) return
    try { editor.message((await session.evaluate(expression)).result) } catch (error) { editor.message(String(error)) }
  }, "Evaluate an expression in the selected stack frame.")
  const evaluateText = async (ed: Editor, expression: string) => {
    const session = currentSession(ed)
    if (session?.state !== "stopped") { ed.message("No stopped debug session"); return }
    if (!expression.trim()) { ed.message("No expression at point"); return }
    try { ed.message((await session.evaluate(expression.trim())).result) } catch (error) { ed.message(String(error)) }
  }
  command("dap-eval-region", async ({ editor, buffer }) => evaluateText(editor, buffer.selectedText()), "Evaluate the active region.")
  command("dap-eval-thing-at-point", async ({ editor, buffer }) => {
    const left = buffer.text.slice(0, buffer.point).match(/[A-Za-z_$][\w.$]*$/)?.[0] ?? ""
    const right = buffer.text.slice(buffer.point).match(/^[\w.$]*/)?.[0] ?? ""
    await evaluateText(editor, left + right)
  }, "Evaluate the symbol at point.")
  command("dap-console-submit", async ({ editor }) => {
    try { await evaluateConsole(editor) } catch (error) { editor.message(error instanceof Error ? error.message : String(error)) }
  }, "Evaluate the current Debug Console input.")

  const currentActive = async (ed: Editor, fn: (session: DapSession) => Promise<void>) => {
    const session = currentSession(ed)
    if (!session) { ed.message("No active dap session"); return }
    try { await fn(session) } catch (error) { ed.message(error instanceof Error ? error.message : String(error)) }
  }
  command("dap-continue", async ({ editor }) => currentActive(editor, session => session.continue()), "Continue the current debug session.")
  command("dap-pause", async ({ editor }) => currentActive(editor, session => session.pause()), "Pause the current debug session.")
  command("dap-next", async ({ editor }) => currentActive(editor, session => session.next()), "Step over in the current debug session.")
  command("dap-step-in", async ({ editor }) => currentActive(editor, session => session.stepIn()), "Step into in the current debug session.")
  command("dap-step-out", async ({ editor }) => currentActive(editor, session => session.stepOut()), "Step out in the current debug session.")
  command("dap-restart-frame", async ({ editor }) => currentActive(editor, session => session.restartFrame()), "Restart the selected stack frame.")
  command("dap-disconnect", async ({ editor }) => currentActive(editor, session => session.disconnect()), "Terminate or disconnect the current debug session.")
  command("dap-stop-thread", async ({ editor }) => currentActive(editor, session => session.stopThread()), "Stop the current debug thread.")
  command("dap-delete-session", async ({ editor }) => {
    const session = currentSession(editor)
    if (!session) { editor.message("No active dap session"); return }
    if (session.state !== "terminated") await session.disconnect()
    const st = state(editor)
    st.sessions = st.sessions.filter(candidate => candidate !== session)
    st.currentSessionId = undefined
    currentSession(editor)
    if (namedBuffer(editor, outputBufferName(session))) editor.killBuffer(outputBufferName(session))
    renderSidebar(editor)
  }, "Delete the current debug session.")
  command("dap-delete-all-sessions", async ({ editor }) => {
    const st = state(editor)
    const sessions = [...st.sessions]
    await Promise.all(sessions.filter(session => session.state !== "terminated").map(session => session.disconnect()))
    for (const session of sessions) if (namedBuffer(editor, outputBufferName(session))) editor.killBuffer(outputBufferName(session))
    st.sessions = []
    st.currentSessionId = undefined
    renderSidebar(editor)
    closeDebugUi(editor)
  }, "Delete all debug sessions.")
  command("dap-debug-restart", async ({ editor, prefixArgument }) => {
    const session = currentSession(editor)
    if (!session) { editor.message("No current debug session"); return }
    const keepSession = getCustom<boolean>("dap-debug-restart-keep-session") ?? true
    const deleteOld = (prefixArgument != null) === keepSession
    const context = await contextFor(editor)
    const launch: LaunchJson = { version: "0.2.0", configurations: [session.config] }
    const oldId = session.id
    if (session.state !== "terminated") await session.disconnect()
    if (deleteOld) {
      const st = state(editor)
      st.sessions = st.sessions.filter(candidate => candidate.id !== oldId)
      st.currentSessionId = undefined
      currentSession(editor)
    }
    await startConfigurations(editor, context, launch, [session.config], session.name, false, true)
  }, "Relaunch the current debug session, optionally deleting the previous session.")
  command("dap-switch-session", async ({ editor }) => {
    const active = state(editor).sessions.filter(session => session.state !== "terminated")
    const name = await editor.completingRead("Debug session: ", { collection: active.map(session => session.name), history: "dap-session" })
    const index = active.findIndex(session => session.name === name)
    if (index < 0) return
    const session = active[index]!
    selectCurrentSession(editor, session)
    runDapHook(editor, "dap-session-changed-hook")
    renderSidebar(editor)
  }, "Select the current debug session.")
  command("dap-switch-thread", async ({ editor }) => {
    const session = currentSession(editor)
    if (session?.state !== "stopped") { editor.message("No stopped debug session"); return }
    const labels = session.threads.map(thread => `${thread.id}: ${thread.name}`)
    const selection = await editor.completingRead("Thread: ", { collection: labels, history: "dap-thread" })
    const threadId = Number(selection?.split(":", 1)[0])
    if (Number.isFinite(threadId)) await session.selectThread(threadId)
  }, "Select the current debug thread.")
  command("dap-switch-stack-frame", async ({ editor }) => {
    const session = currentSession(editor)
    if (session?.state !== "stopped") { editor.message("No stopped debug session"); return }
    const labels = session.frames.map(frame => `${frame.id}: ${frame.name} (${frame.source?.name ?? frame.source?.path ?? "unknown"}:${frame.line})`)
    const selection = await editor.completingRead("Stack frame: ", { collection: labels, history: "dap-stack-frame" })
    const frameId = Number(selection?.split(":", 1)[0])
    if (Number.isFinite(frameId)) { await session.selectFrame(frameId); runDapHook(editor, "dap-stack-frame-changed-hook"); await navigateToFrame(editor, session); await refreshWatches(editor) }
  }, "Select the current stack frame.")
  const moveFrame = async (ed: Editor, delta: number, prefixArgument: number | null = null) => {
    const session = currentSession(ed)
    if (session?.state !== "stopped" || !session.selectedFrame) { ed.message("No stopped debug session"); return }
    const index = session.frames.findIndex(frame => frame.id === session.selectedFrame?.id)
    const count = Math.max(1, Math.abs(prefixArgument ?? 1))
    const direction = prefixArgument != null && prefixArgument < 0 ? -delta : delta
    const frame = session.frames[index + direction * count]
    if (!frame) { ed.message(delta > 0 ? "Bottom stack frame" : "Top stack frame"); return }
    await session.selectFrame(frame.id)
    runDapHook(ed, "dap-stack-frame-changed-hook")
    await navigateToFrame(ed, session)
    await refreshWatches(ed)
  }
  command("dap-up-stack-frame", async ({ editor, prefixArgument }) => moveFrame(editor, 1, prefixArgument), "Move up one stack frame.")
  command("dap-down-stack-frame", async ({ editor, prefixArgument }) => moveFrame(editor, -1, prefixArgument), "Move down one stack frame.")
  command("dap-ui-show-many-windows", async ({ editor }) => {
    await contextFor(editor).catch(() => null)
    openDebugUi(editor)
  }, "Show the auto-configured DAP UI windows.")
  command("dap-ui-hide-many-windows", ({ editor }) => {
    if (uiVisible(editor)) closeDebugUi(editor)
  }, "Hide the auto-configured DAP UI windows.")
  command("dap-ui-repl", ({ editor }) => {
    openDebugUi(editor)
    let buffer = consoleBuffer(editor)
    if (!buffer) {
      buffer = new BufferModel({ name: CONSOLE_NAME, kind: "scratch", mode: CONSOLE_MODE })
      editor.addBuffer(buffer)
      editor.enterMode(buffer, CONSOLE_MODE)
    }
    editor.displayBufferInOtherWindow(buffer.id, { select: true })
    state(editor).consoleWindowId = editor.selectedWindowId
    renderConsole(editor)
  }, "Show and select the DAP REPL.")
  const uiCommands: Array<[string, (st: EditorState) => WindowId | undefined]> = [
    ["dap-ui-sessions", st => st.sessionsWindowId],
    ["dap-ui-locals", st => st.localsWindowId],
    ["dap-ui-expressions", st => st.expressionsWindowId],
    ["dap-ui-breakpoints", st => st.sidebarWindowId],
  ]
  for (const [name, windowId] of uiCommands) {
    command(name, async ({ editor: ed }) => {
      await contextFor(ed).catch(() => null)
      openDebugUi(ed)
      const id = windowId(state(ed))
      if (id) ed.selectWindow(id)
    }, `Show ${name.replace("dap-ui-", "")} for the current debug session.`)
  }
  command("dap-hydra", ({ editor: ed }) => {
    ed.message("DAP: n next, i step in, o step out, c continue, r restart frame; M-x dap-* for debug, breakpoints, switch, and eval")
  }, "Show the dap-mode command hydra summary.")
  command("dap-ui-activate", async ({ editor, buffer }) => {
    const actions = buffer.locals.get(UI_ACTIONS) as Array<UiAction | undefined> | undefined
    const action = actions?.[buffer.lineAt(buffer.point)]
    if (!action) return
    if (action.kind === "header") {
      const expanded = state(editor).expanded
      if (expanded.has(action.section)) expanded.delete(action.section); else expanded.add(action.section)
      renderSidebar(editor)
    } else if (action.kind === "frame") {
      const session = state(editor).sessions.find(candidate => candidate.id === action.sessionId)
      if (session) { selectCurrentSession(editor, session); await session.selectFrame(action.frameId); runDapHook(editor, "dap-stack-frame-changed-hook"); await navigateToFrame(editor, session); await refreshWatches(editor) }
    } else if (action.kind === "session") {
      const session = state(editor).sessions.find(candidate => candidate.id === action.sessionId)
      if (session) { selectCurrentSession(editor, session); runDapHook(editor, "dap-session-changed-hook"); renderSidebar(editor); await refreshWatches(editor) }
    } else if (action.kind === "variable") {
      const session = state(editor).sessions.find(candidate => candidate.id === action.sessionId)
      if (!session) return
      const key = `${session.id}:var:${action.variablesReference}`
      if (state(editor).expanded.has(key)) state(editor).expanded.delete(key)
      else {
        state(editor).expanded.add(key)
        await session.variables(action.variablesReference)
      }
      renderSidebar(editor)
    } else if (action.kind === "breakpoint") {
      const breakpoint = Object.values(state(editor).persisted.projects).flatMap(project => project.breakpoints).find(item => item.id === action.id)
      if (breakpoint) {
        const main = state(editor).mainWindowId
        if (main) editor.selectWindow(main)
        const target = await editor.openFile(breakpoint.path)
        target.point = target.lineStarts[breakpoint.line - 1] ?? 0
        editor.setSelectedWindowPoint(target.point)
      }
    }
  }, "Activate the dap UI row at point.")

  void loadState(editor).then(() => {
    if (!editor.isMinorModeEnabled("dap-auto-configure-mode")) editor.enableMinorMode("dap-auto-configure-mode")
    return editor.changed("dap-state-loaded")
  })
  ctx.onDispose(() => {
    for (const session of state(editor).sessions) void session.disconnect()
  })
}
