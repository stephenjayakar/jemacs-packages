import {
  BufferModel,
  Keymap,
  createPluginContext,
  defineMode,
  defcustom,
  getCustom,
  killNew,
  listWindowLeaves,
  nextWindowId,
  normalizeSequence,
  type Editor,
  type KeyEventLike,
  type PluginContext,
  type WindowNode,
} from "@jemacs/core"
import { join } from "node:path"
import { jemacsHome } from "../core-path"
import {
  paneIds,
  parseTmuxLayout,
  tmuxClientExtent,
  tmuxLayoutToWindowTree,
  windowInDirection,
  type TmuxLayoutNode,
} from "./layout"
import {
  bytesToHexArgs,
  ControlModeParser,
  stripProblematicEscapes,
  tmuxQuote,
  type ControlEvent,
} from "./protocol"

const PANE_MODE = "tmux-cc-pane-mode"
const PANE_COPY_MODE = "tmux-cc-pane-copy-mode"
const MANAGER_MODE = "tmux-cc-manager-mode"
const PANE_ID_LOCAL = "tmux-cc-pane-id"
const MANAGER_TARGETS_LOCAL = "tmux-cc-manager-targets"
const PASTE_HANDLER_LOCAL = "paste-handler"
const TERMINAL_SURFACE_LOCAL = "terminal-surface"

type JTermTransport = {
  pid: number
  write(data: string): void
  resize(rows: number, cols: number): void
  onData(fn: (chunk: string) => void): void
  onExit(fn: (code: number | null) => void): void
  kill(): void
}

type JTermSession = {
  charMode: boolean
  cursorPoint: number
  rows: number
  cols: number
  feed(data: string): Promise<void>
  writeRaw(data: string): void
  resize(rows: number, cols: number): void
  mirrorFromXterm(): void
  dispose(): void
}

type JTermModule = {
  sessions: WeakMap<BufferModel, JTermSession>
  keyToPtyBytes(key: KeyEventLike): string
  spawnPtyTransport(
    argv: string[],
    options: { cwd?: string; env?: Record<string, string>; rows: number; cols: number },
  ): Promise<JTermTransport>
  attachTransportSession(
    editor: Editor,
    buffer: BufferModel,
    transport: JTermTransport,
    options: { rows: number; cols: number; label: string },
  ): JTermSession
}

type PendingCommand = {
  command: string
  resolve(lines: string[]): void
  reject(error: Error): void
}

type PaneRecord = {
  id: string
  buffer: BufferModel
  transport: TmuxPaneTransport
  session: JTermSession
  history: "pending" | "loaded"
  historyOutput: string[]
  copyOutput: string[]
  copying: boolean
  feedChain: Promise<void>
}

type SessionRow = { name: string; id: string; attached: string; windows: string }
type WindowRow = { session: string; name: string; id: string; active: string; layout: string; paneId: string }
type PaneRow = { session: string; windowId: string; id: string; active: string; command: string; size: string }
type ManagerTarget = { line: number; type: "session" | "window" | "pane"; id: string; paneId?: string; label: string }
type ManagerData = { sessions: SessionRow[]; windows: WindowRow[]; panes: PaneRow[] }

const controllers = new WeakMap<Editor, TmuxCcController>()

export function controllerFor(editor: Editor): TmuxCcController | undefined {
  return controllers.get(editor)
}

async function loadJterm(): Promise<JTermModule> {
  const [jterm, session] = await Promise.all([
    import(join(jemacsHome(), "plugins/jterm/index.ts")),
    import(join(jemacsHome(), "plugins/jterm/session.ts")),
  ])
  return {
    sessions: jterm.sessions,
    keyToPtyBytes: jterm.keyToPtyBytes,
    spawnPtyTransport: session.spawnPtyTransport,
    attachTransportSession: session.attachTransportSession,
  } as JTermModule
}

class TmuxPaneTransport implements JTermTransport {
  readonly pid = 0
  private alive = true
  private dataHandlers: Array<(chunk: string) => void> = []
  private exitHandlers: Array<(code: number | null) => void> = []

  constructor(private readonly controller: TmuxCcController, readonly paneId: string) {}

  write(data: string): void {
    if (this.alive) this.controller.sendPaneBytes(this.paneId, data)
  }

  resize(_rows: number, _cols: number): void {}

  onData(fn: (chunk: string) => void): void {
    this.dataHandlers.push(fn)
  }

  onExit(fn: (code: number | null) => void): void {
    this.exitHandlers.push(fn)
  }

  emit(data: string): void {
    if (!this.alive) return
    for (const handler of this.dataHandlers) handler(data)
  }

  kill(): void {
    if (!this.alive) return
    this.alive = false
    this.dataHandlers = []
    this.exitHandlers = []
  }
}

class TmuxPaneRawMap extends Keymap {
  constructor(private readonly passthrough: Set<string>) {
    super("tmux-cc-pane-mode-map")
  }

  override get(sequence: string): string | undefined {
    const normalized = normalizeSequence(sequence)
    const explicit = super.get(normalized)
    if (explicit) return explicit
    if (!normalized || this.passthrough.has(normalized)) return undefined
    const tokens = normalized.split(" ")
    if (tokens.length === 1 || (tokens.length === 2 && tokens[0] === "C-c")) {
      return "tmux-cc-send-raw"
    }
    return undefined
  }
}

export class TmuxCcController {
  readonly parser = new ControlModeParser()
  readonly panes = new Map<string, PaneRecord>()
  private control: JTermTransport | null = null
  private active = false
  private cleaning = false
  private queue: PendingCommand[] = []
  private currentCommand: PendingCommand | null = null
  private commandLines: string[] = []
  private readyPromise: Promise<void> = Promise.resolve()
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private managerData: ManagerData = { sessions: [], windows: [], panes: [] }
  private preview: { type: ManagerTarget["type"]; id: string; paneId: string; label: string } | null = null
  private currentLayout: TmuxLayoutNode | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private geometryTimer: ReturnType<typeof setTimeout> | null = null
  private lastClientSize = ""

  constructor(readonly editor: Editor, readonly jterm: JTermModule) {}

  get running(): boolean {
    return this.active
  }

  async start(command: string): Promise<void> {
    if (this.active) {
      const answer = await this.editor.prompt("A tmux-cc process is already running. Kill it? (y or n) ", "n", "tmux-cc-confirm")
      if (!answer || !/^y(es)?$/i.test(answer.trim())) return
      this.stop("Replaced by a new tmux control session.")
    }
    this.resetState()
    this.renderManagerStatus("Connecting...\n\nWaiting for tmux control mode to finish attaching.")
    this.showManager()
    const shell = process.env.SHELL ?? "/bin/sh"
    try {
      const rows = Math.max(2, this.editor.lastViewport?.rows ?? 30)
      const cols = Math.max(20, this.editor.lastViewport?.cols ?? 100)
      this.control = await this.jterm.spawnPtyTransport([shell, "-lc", `exec ${command}`], {
        cwd: this.editor.currentBuffer.directory?.() ?? process.cwd(),
        rows,
        cols,
      })
      this.active = true
      this.control.onData(chunk => this.handleChunk(chunk))
      this.control.onExit(code => {
        if (this.active) this.stop(`tmux-cc process exited ${code ?? "?"}`, false)
      })
      void this.readyPromise.then(async () => {
        if (!this.active) return
        await this.refreshManager()
        await this.bootstrapCurrentLayout()
        this.scheduleGeometry(true)
      }).catch(error => {
        if (this.active) this.stop(error instanceof Error ? error.message : String(error))
      })
      this.editor.message("Started tmux-cc process")
    } catch (error) {
      this.stop(`Unable to start tmux-cc: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  stop(reason = "tmux-cc stopped", killControl = true): void {
    if (this.cleaning) return
    this.cleaning = true
    const control = this.control
    this.active = false
    this.control = null
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.geometryTimer) clearTimeout(this.geometryTimer)
    this.refreshTimer = null
    this.geometryTimer = null
    const error = new Error(reason)
    this.currentCommand?.reject(error)
    this.currentCommand = null
    for (const pending of this.queue.splice(0)) pending.reject(error)
    this.readyReject?.(error)
    this.readyResolve = null
    this.readyReject = null
    for (const pane of [...this.panes.values()]) this.disposePane(pane, true)
    this.panes.clear()
    this.currentLayout = null
    this.preview = null
    this.lastClientSize = ""
    this.parser.reset()
    if (killControl) control?.kill()
    this.renderManagerStatus(`Session closed\n\n${reason}\n\nRun M-x tmux-cc-start to reconnect.`)
    this.cleaning = false
  }

  sendCommand(command: string): Promise<string[]> {
    if (!this.active || !this.control) return Promise.reject(new Error("tmux-cc process is not running"))
    return new Promise<string[]>((resolve, reject) => {
      this.queue.push({ command, resolve, reject })
      this.control!.write(`${command}\n`)
    })
  }

  sendPaneBytes(paneId: string, value: string): void {
    if (!this.active || !value) return
    const hex = bytesToHexArgs(value)
    const chunkSize = 512
    for (let i = 0; i < hex.length; i += chunkSize) {
      const args = hex.slice(i, i + chunkSize).join(" ")
      void this.sendCommand(`send-keys -t ${tmuxQuote(paneId)} -H ${args}`).catch(() => {})
    }
  }

  paneForBuffer(buffer: BufferModel): PaneRecord | undefined {
    const paneId = buffer.locals.get(PANE_ID_LOCAL) as string | undefined
    return paneId ? this.panes.get(paneId) : undefined
  }

  async enterCopyMode(buffer: BufferModel): Promise<void> {
    const pane = this.paneForBuffer(buffer)
    if (!pane) return this.editor.message("Current buffer is not a tmux pane") as unknown as void
    if (pane.copying) return this.leaveCopyMode(buffer)
    await pane.feedChain
    pane.copying = true
    pane.session.charMode = false
    buffer.locals.delete(PASTE_HANDLER_LOCAL)
    buffer.locals.delete(TERMINAL_SURFACE_LOCAL)
    this.editor.enterMode(buffer, PANE_COPY_MODE)
    buffer.readOnly = true
    await this.editor.changed("tmux-cc-copy-mode")
  }

  async leaveCopyMode(buffer: BufferModel): Promise<void> {
    const pane = this.paneForBuffer(buffer)
    if (!pane) return
    pane.copying = false
    pane.session.charMode = true
    this.editor.enterMode(buffer, PANE_MODE)
    buffer.readOnly = true
    this.installPasteHandler(pane)
    const queued = pane.copyOutput.splice(0)
    if (queued.length) this.queuePaneFeed(pane, queued.join(""))
    else pane.session.mirrorFromXterm()
    buffer.point = pane.session.cursorPoint
    await pane.feedChain
    await this.editor.changed("tmux-cc-char-mode")
  }

  async copyModeDone(buffer: BufferModel): Promise<void> {
    const selected = buffer.selectedText()
    killNew(this.editor, selected || buffer.lineBoundsAt().text)
    buffer.markActive = false
    await this.leaveCopyMode(buffer)
    this.editor.message(selected ? "Copied region" : "Copied line")
  }

  handlePaneOutput(paneId: string, data: string): void {
    const pane = this.panes.get(paneId) ?? this.createPane(paneId)
    const clean = getCustom<boolean>("tmux-cc-strip-problematic-escape-sequences")
      ? stripProblematicEscapes(data)
      : data
    if (pane.history === "pending") pane.historyOutput.push(clean)
    else if (pane.copying) pane.copyOutput.push(clean)
    else this.queuePaneFeed(pane, clean)
  }

  createPane(paneId: string): PaneRecord {
    const existing = this.panes.get(paneId)
    if (existing) return existing
    const buffer = new BufferModel({
      name: `${getCustom<string>("tmux-cc-pane-buffer-prefix") ?? "tmux-pane "}${paneId}`,
      text: "",
      kind: "scratch",
      mode: PANE_MODE,
    })
    this.editor.addBuffer(buffer)
    this.editor.enterMode(buffer, PANE_MODE)
    buffer.locals.set(PANE_ID_LOCAL, paneId)
    buffer.locals.set("display-line-numbers", false)
    buffer.readOnly = true
    const rows = Math.max(1, buffer.locals.get("window-body-rows") as number | undefined ?? 30)
    const cols = Math.max(1, buffer.locals.get("window-body-cols") as number | undefined ?? 100)
    const transport = new TmuxPaneTransport(this, paneId)
    const session = this.jterm.attachTransportSession(this.editor, buffer, transport, { rows, cols, label: "tmux-cc" })
    session.charMode = true
    this.jterm.sessions.set(buffer, session)
    const pane: PaneRecord = {
      id: paneId,
      buffer,
      transport,
      session,
      history: "pending",
      historyOutput: [],
      copyOutput: [],
      copying: false,
      feedChain: Promise.resolve(),
    }
    this.panes.set(paneId, pane)
    this.installPasteHandler(pane)
    void this.readyPromise.then(() => this.requestHistory(pane)).catch(() => {})
    return pane
  }

  removePaneForBuffer(buffer: BufferModel): void {
    const pane = this.paneForBuffer(buffer)
    if (!pane) return
    pane.transport.kill()
    this.panes.delete(pane.id)
    if (this.preview?.paneId === pane.id) this.preview = null
  }

  showPane(paneId: string): void {
    const pane = this.panes.get(paneId) ?? this.createPane(paneId)
    this.editor.switchToBuffer(pane.buffer.id)
    this.scheduleGeometry()
  }

  selectPaneForCurrentWindow(): void {
    const pane = this.paneForBuffer(this.editor.currentBuffer)
    if (pane) void this.sendCommand(`select-pane -t ${tmuxQuote(pane.id)}`).catch(() => {})
  }

  smartOtherWindow(delta: number): void {
    const target = nextWindowId(this.editor.windowLayout, this.editor.selectedWindowId, delta)
    this.editor.selectWindow(target)
    this.selectPaneForCurrentWindow()
  }

  focus(direction: "left" | "right" | "up" | "down"): void {
    const target = windowInDirection(this.editor.windowLayout, this.editor.selectedWindowId, direction)
    if (target) {
      const leaf = listWindowLeaves(this.editor.windowLayout).find(candidate => candidate.id === target)
      const buffer = leaf ? this.editor.buffers.get(leaf.bufferId) : undefined
      if (buffer && this.paneForBuffer(buffer)) {
        this.editor.selectWindow(target)
        this.selectPaneForCurrentWindow()
        return
      }
    }
    const selector = { left: "-L", right: "-R", up: "-U", down: "-D" }[direction]
    const pane = this.requireCurrentPane()
    if (pane) void this.sendCommand(`select-pane ${selector} -t ${tmuxQuote(pane.id)}`).catch(() => {})
  }

  focusNext(previous = false): void {
    const directions: Array<"left" | "right" | "up" | "down"> = previous
      ? ["left", "up", "right", "down"]
      : ["right", "down", "left", "up"]
    for (const direction of directions) {
      const target = windowInDirection(this.editor.windowLayout, this.editor.selectedWindowId, direction)
      const leaf = target ? listWindowLeaves(this.editor.windowLayout).find(candidate => candidate.id === target) : undefined
      const buffer = leaf ? this.editor.buffers.get(leaf.bufferId) : undefined
      if (target && buffer && this.paneForBuffer(buffer)) {
        this.editor.selectWindow(target)
        this.selectPaneForCurrentWindow()
        return
      }
    }
    void this.sendCommand(`select-pane -t:${previous ? ".-" : ".+"}`).catch(() => {})
  }

  async runAndRefresh(command: string): Promise<string[]> {
    const lines = await this.sendCommand(command)
    await this.bootstrapCurrentLayout()
    if (this.managerBuffer()) await this.refreshManager()
    return lines
  }

  async bootstrapCurrentLayout(): Promise<void> {
    if (!this.active) return
    const lines = await this.sendCommand("list-windows -F '#{window_active}\t#{window_id}\t#{window_layout}'")
    const selected = lines.find(line => line.startsWith("1\t")) ?? lines[0]
    if (!selected) return
    const [, windowId, layout] = selected.split("\t")
    if (windowId && layout) this.handleLayout(windowId, layout)
  }

  handleLayout(_windowId: string, layout: string): void {
    try {
      const parsed = parseTmuxLayout(layout)
      this.currentLayout = parsed
      for (const paneId of paneIds(parsed)) this.createPane(paneId)
      if (!this.paneForBuffer(this.editor.currentBuffer)) return
      const selectedWindowId = this.editor.selectedWindowId
      const existingWindows = new Map(
        listWindowLeaves(this.editor.windowLayout).map(leaf => [leaf.bufferId, leaf.id]),
      )
      const tree = tmuxLayoutToWindowTree(
        parsed,
        paneId => this.createPane(paneId).buffer,
        selectedWindowId,
        paneId => existingWindows.get(this.createPane(paneId).buffer.id),
      )
      this.editor.mutateWindowLayout(() => tree, "tmux-cc-layout")
      this.scheduleGeometry()
    } catch (error) {
      this.editor.message(`tmux-cc layout: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  scheduleGeometry(force = false): void {
    if (this.geometryTimer) clearTimeout(this.geometryTimer)
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = null
      void this.refreshGeometry(force)
    }, 50)
  }

  async refreshGeometry(force = false): Promise<void> {
    if (!this.active) return
    for (const leaf of listWindowLeaves(this.editor.windowLayout)) {
      const buffer = this.editor.buffers.get(leaf.bufferId)
      const pane = buffer ? this.paneForBuffer(buffer) : undefined
      if (!pane) continue
      const rows = buffer!.locals.get("window-body-rows") as number | undefined
      const cols = buffer!.locals.get("window-body-cols") as number | undefined
      if (rows && cols) pane.session.resize(rows, cols)
    }
    const extent = this.currentLayout && tmuxClientExtent(this.currentLayout, paneId => {
      const pane = this.panes.get(paneId)
      return pane ? { rows: pane.session.rows, cols: pane.session.cols } : undefined
    })
    if (!extent || getCustom<boolean>("tmux-cc-sync-client-size") === false) return
    const size = `${extent.cols}x${extent.rows}`
    if (!force && size === this.lastClientSize) return
    this.lastClientSize = size
    await this.sendCommand(`refresh-client -C ${size}`)
  }

  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (!this.active) return
      void this.refreshManager().then(() => this.bootstrapCurrentLayout()).catch(() => {})
    }, 50)
  }

  async refreshManager(): Promise<void> {
    if (!this.active) {
      this.renderManagerStatus("Session closed\n\ntmux-cc process is not running")
      return
    }
    const sessionLines = await this.sendCommand("list-sessions -F '#{session_name}\t#{session_id}\t#{session_attached}\t#{session_windows}'")
    const windowLines = await this.sendCommand("list-windows -a -F '#{session_name}\t#{window_name}\t#{window_id}\t#{window_active}\t#{window_layout}\t#{pane_id}'")
    const paneLines = await this.sendCommand("list-panes -a -F '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_active}\t#{pane_current_command}\t#{pane_width}x#{pane_height}'")
    this.managerData = {
      sessions: sessionLines.map(line => {
        const [name = "", id = "", attached = "", windows = ""] = line.split("\t")
        return { name, id, attached, windows }
      }),
      windows: windowLines.map(line => {
        const [session = "", name = "", id = "", active = "", layout = "", paneId = ""] = line.split("\t")
        return { session, name, id, active, layout, paneId }
      }),
      panes: paneLines.map(line => {
        const [session = "", windowId = "", id = "", active = "", command = "", size = ""] = line.split("\t")
        return { session, windowId, id, active, command, size }
      }),
    }
    const live = new Set(this.managerData.panes.map(pane => pane.id))
    for (const paneId of live) this.createPane(paneId)
    for (const pane of [...this.panes.values()]) {
      if (!live.has(pane.id)) this.disposePane(pane, true)
    }
    this.renderManager()
  }

  showManager(): void {
    const buffer = this.ensureManagerBuffer()
    this.editor.switchToBuffer(buffer.id)
  }

  managerTarget(buffer = this.editor.currentBuffer): ManagerTarget | undefined {
    const targets = buffer.locals.get(MANAGER_TARGETS_LOCAL) as ManagerTarget[] | undefined
    const line = buffer.lineAt(buffer.point)
    return targets?.find(target => target.line === line)
  }

  togglePreview(): void {
    const target = this.managerTarget()
    if (!target?.paneId) return void this.editor.message("No previewable tmux pane on this line")
    if (this.preview?.paneId === target.paneId) this.preview = null
    else this.preview = { type: target.type, id: target.id, paneId: target.paneId, label: target.label }
    this.renderManager()
  }

  async visitManagerTarget(): Promise<void> {
    const target = this.managerTarget()
    if (!target) return void this.editor.message("No tmux target on this line")
    if (target.paneId) this.showPane(target.paneId)
    const command = target.type === "session"
      ? `switch-client -t ${tmuxQuote(target.id)}`
      : target.type === "window"
        ? `select-window -t ${tmuxQuote(target.id)}`
        : `select-pane -t ${tmuxQuote(target.id)}`
    await this.sendCommand(command)
    await this.bootstrapCurrentLayout()
    await this.refreshManager()
    if (target.paneId) this.showPane(target.paneId)
  }

  async deleteManagerTarget(): Promise<void> {
    const target = this.managerTarget()
    if (!target) return void this.editor.message("No tmux target on this line")
    if (getCustom<boolean>("tmux-cc-confirm-destructive-actions") !== false) {
      const answer = await this.editor.prompt(`Kill ${target.type} ${target.label}? (y or n) `, "n", "tmux-cc-confirm")
      if (!answer || !/^y(es)?$/i.test(answer.trim())) return
    }
    this.preview = null
    const command = target.type === "session"
      ? `kill-session -t ${tmuxQuote(target.id)}`
      : target.type === "window"
        ? `kill-window -t ${tmuxQuote(target.id)}`
        : `kill-pane -t ${tmuxQuote(target.id)}`
    await this.runAndRefresh(command)
  }

  showManagerHelp(): void {
    const name = getCustom<string>("tmux-cc-manager-help-buffer-name") ?? "*tmux-control-help*"
    let buffer = [...this.editor.buffers.values()].find(candidate => candidate.name === name)
    if (!buffer) {
      buffer = new BufferModel({ name, kind: "scratch", mode: "text" })
      this.editor.addBuffer(buffer)
    }
    buffer.readOnly = false
    buffer.setText([
      "Tmux Control Manager",
      "",
      "RET  Visit the tmux target at point",
      "TAB  Preview the pane for the current line",
      "g    Refresh sessions, windows, and panes",
      "h/?  Show this help buffer",
      "k    Kill the target at point",
      "n    Create a new tmux window",
      "S    Create a new detached tmux session",
      "r    Rename the tmux session at point",
      "c    Run an arbitrary tmux command",
      "s/w  Switch sessions/windows",
      "d    Detach the active tmux client",
      "q    Bury the help buffer",
    ].join("\n"), false, false)
    buffer.readOnly = true
    this.editor.switchToBuffer(buffer.id)
  }

  renderManager(): void {
    const buffer = this.ensureManagerBuffer()
    const lines: string[] = []
    const targets: ManagerTarget[] = []
    const push = (text: string, target?: Omit<ManagerTarget, "line">) => {
      const line = lines.length
      lines.push(text)
      if (target) targets.push({ ...target, line })
      if (target && this.preview?.type === target.type && this.preview.id === target.id) {
        lines.push(`  | Preview ${this.preview.label} (${this.preview.paneId})`)
        for (const previewLine of this.previewSnapshot(this.preview.paneId)) lines.push(`  | ${previewLine}`)
      }
    }
    const windowPane = new Map<string, string>()
    const sessionPane = new Map<string, string>()
    for (const pane of this.managerData.panes) {
      if (!windowPane.has(pane.windowId) || pane.active === "1") windowPane.set(pane.windowId, pane.id)
    }
    for (const window of this.managerData.windows) {
      const paneId = windowPane.get(window.id) ?? window.paneId
      if (!sessionPane.has(window.session) || window.active === "1") sessionPane.set(window.session, paneId)
    }
    push("Tmux Control")
    push("RET visit, TAB preview, g refresh, h help, k kill, n new-window, S new-session, r rename, c command, d detach")
    push("")
    push("Sessions")
    for (const session of this.managerData.sessions) {
      push(`${session.attached !== "0" ? "*" : " "} ${session.name.padEnd(16)} ${session.id.padEnd(6)} ${session.windows.padStart(2)} windows attached:${session.attached}`, {
        type: "session", id: session.name, paneId: sessionPane.get(session.name), label: session.name,
      })
    }
    push("")
    push("Windows")
    for (const window of this.managerData.windows) {
      push(`${window.active === "1" ? "*" : " "} ${window.session.padEnd(16)} ${window.name.padEnd(16)} ${window.id.padEnd(5)} ${window.layout}`, {
        type: "window", id: window.id, paneId: windowPane.get(window.id) ?? window.paneId, label: `${window.session}:${window.name}`,
      })
    }
    push("")
    push("Panes")
    for (const pane of this.managerData.panes) {
      push(`${pane.active === "1" ? "*" : " "} ${pane.session.padEnd(16)} ${pane.windowId.padEnd(6)} ${pane.id.padEnd(6)} ${pane.command.padEnd(16)} ${pane.size}`, {
        type: "pane", id: pane.id, paneId: pane.id, label: `${pane.windowId}/${pane.id}`,
      })
    }
    buffer.readOnly = false
    const oldLine = buffer.lineAt(buffer.point)
    buffer.setText(lines.join("\n"), false, false)
    buffer.readOnly = true
    buffer.locals.set(MANAGER_TARGETS_LOCAL, targets)
    buffer.point = buffer.lineStarts[Math.min(oldLine, buffer.lineCount - 1)] ?? 0
    void this.editor.changed("tmux-cc-manager")
  }

  renderManagerStatus(text: string): void {
    const buffer = this.ensureManagerBuffer()
    buffer.readOnly = false
    buffer.setText(`Tmux Control\n${text}\n`, false, false)
    buffer.readOnly = true
    buffer.locals.set(MANAGER_TARGETS_LOCAL, [])
    buffer.point = 0
    void this.editor.changed("tmux-cc-manager-status")
  }

  private resetState(): void {
    this.parser.reset()
    this.queue = []
    this.currentCommand = null
    this.commandLines = []
    this.currentLayout = null
    this.preview = null
    this.managerData = { sessions: [], windows: [], panes: [] }
    this.lastClientSize = ""
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    void this.readyPromise.catch(() => {})
  }

  private handleChunk(chunk: string): void {
    for (const event of this.parser.push(chunk)) this.handleEvent(event)
  }

  private handleEvent(event: ControlEvent): void {
    switch (event.type) {
      case "begin":
        this.currentCommand = this.queue.shift() ?? null
        this.commandLines = []
        break
      case "end": {
        const command = this.currentCommand
        const lines = this.commandLines
        this.currentCommand = null
        this.commandLines = []
        if (command) command.resolve(lines)
        else if (this.readyResolve) {
          const resolve = this.readyResolve
          this.readyResolve = null
          this.readyReject = null
          resolve()
        }
        break
      }
      case "error": {
        const error = new Error(`tmux error: ${[...this.commandLines, event.line].join("\n")}`)
        this.currentCommand?.reject(error)
        this.currentCommand = null
        this.commandLines = []
        this.stop(error.message)
        break
      }
      case "output":
        this.handlePaneOutput(event.paneId, event.data)
        break
      case "layout-change":
        this.handleLayout(event.windowId, event.layout)
        break
      case "notification":
        if (this.currentCommand) this.commandLines.push(event.line)
        else if (event.name === "exit") this.stop("tmux control client detached", false)
        else if (["session-changed", "sessions-changed", "session-window-changed", "window-add", "window-close", "window-pane-changed", "window-renamed"].includes(event.name)) this.scheduleRefresh()
        break
      case "line":
        if (this.currentCommand) this.commandLines.push(event.line)
        break
    }
  }

  private queuePaneFeed(pane: PaneRecord, data: string): void {
    if (!data) return
    pane.feedChain = pane.feedChain
      .then(() => pane.session.feed(data))
      .then(() => {
        if (this.preview?.paneId === pane.id) this.renderManager()
      })
      .catch(error => {
        this.editor.message(`tmux-cc pane ${pane.id}: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  private async requestHistory(pane: PaneRecord): Promise<void> {
    if (!this.active || pane.history !== "pending") return
    const count = Math.max(0, Math.floor(getCustom<number>("tmux-cc-pane-history-lines") ?? 200))
    const lines = count > 0
      ? await this.sendCommand(`capture-pane -e -p -S -${count} -E - -t ${tmuxQuote(pane.id)}`)
      : []
    if (!this.panes.has(pane.id)) return
    const chunks: string[] = []
    if (lines.length) chunks.push(`${lines.join("\r\n")}\r\n`)
    chunks.push(...pane.historyOutput.splice(0))
    pane.history = "loaded"
    if (pane.copying) pane.copyOutput.push(...chunks)
    else this.queuePaneFeed(pane, chunks.join(""))
  }

  private installPasteHandler(pane: PaneRecord): void {
    pane.buffer.locals.set(PASTE_HANDLER_LOCAL, (text: string) => {
      const bracketed = getCustom<boolean>("jterm-bracketed-paste") !== false
      pane.session.writeRaw(bracketed ? `\x1b[200~${text}\x1b[201~` : text)
    })
  }

  private disposePane(pane: PaneRecord, killBuffer: boolean): void {
    pane.transport.kill()
    pane.session.dispose()
    this.jterm.sessions.delete(pane.buffer)
    this.panes.delete(pane.id)
    if (this.preview?.paneId === pane.id) this.preview = null
    if (killBuffer && this.editor.buffers.has(pane.buffer.id)) this.editor.killBuffer(pane.buffer.id)
  }

  private requireCurrentPane(): PaneRecord | undefined {
    const pane = this.paneForBuffer(this.editor.currentBuffer)
    if (!pane) this.editor.message("Current buffer is not a tmux pane")
    return pane
  }

  private managerBuffer(): BufferModel | undefined {
    const name = getCustom<string>("tmux-cc-manager-buffer-name") ?? "*tmux-control*"
    return [...this.editor.buffers.values()].find(buffer => buffer.name === name)
  }

  private ensureManagerBuffer(): BufferModel {
    let buffer = this.managerBuffer()
    if (!buffer) {
      buffer = new BufferModel({
        name: getCustom<string>("tmux-cc-manager-buffer-name") ?? "*tmux-control*",
        kind: "scratch",
        mode: MANAGER_MODE,
      })
      this.editor.addBuffer(buffer)
    }
    this.editor.enterMode(buffer, MANAGER_MODE)
    buffer.readOnly = true
    return buffer
  }

  private previewSnapshot(paneId: string): string[] {
    const pane = this.panes.get(paneId)
    if (!pane || !pane.buffer.text) return [pane ? "[No pane output yet]" : "[Pane buffer unavailable]"]
    const max = Math.max(1, Math.floor(getCustom<number>("tmux-cc-manager-preview-window-size") ?? 12))
    return pane.buffer.text.replace(/\n$/, "").split("\n").slice(-max)
  }
}

function registerCustoms(): void {
  const group = "tmux-cc"
  defcustom("tmux-cc-passthrough-keys", "sexp", ["C-x", "M-x", "C-t", "C-tab", "C-S-tab", "C-M-S-tab", "s-]", "s-{", "s-t", "s-w", "C-\\"], "Keys that bypass terminal input.", group)
  defcustom("tmux-cc-strip-problematic-escape-sequences", "boolean", false, "Strip compatibility escape sequences before JTerm.", group)
  defcustom("tmux-cc-focus-next-key", "string", "C-tab", "Focus-next key.", group)
  defcustom("tmux-cc-focus-prev-key", "string", "C-S-tab", "Focus-previous key.", group)
  defcustom("tmux-cc-focus-other-key", "string", "C-x o", "Focus another tmux pane.", group)
  defcustom("tmux-cc-command-key", "string", "C-t !", "Arbitrary tmux command key.", group)
  defcustom("tmux-cc-split-horizontal-key", "string", "C-t 3", "Split-right key.", group)
  defcustom("tmux-cc-split-vertical-key", "string", "C-t 2", "Split-below key.", group)
  defcustom("tmux-cc-new-window-key", "string", "C-t c", "New-window key.", group)
  defcustom("tmux-cc-new-session-key", "string", "C-t S", "New-session key.", group)
  defcustom("tmux-cc-manager-key", "string", "C-t t", "Manager key.", group)
  defcustom("tmux-cc-switch-window-key", "string", "C-t w", "Switch-window key.", group)
  defcustom("tmux-cc-switch-session-key", "string", "C-t s", "Switch-session key.", group)
  defcustom("tmux-cc-detach-key", "string", "C-t d", "Detach key.", group)
  defcustom("tmux-cc-kill-pane-key", "string", "C-t k", "Kill-pane key.", group)
  defcustom("tmux-cc-manager-buffer-name", "string", "*tmux-control*", "Manager buffer name.", group)
  defcustom("tmux-cc-manager-help-buffer-name", "string", "*tmux-control-help*", "Manager help buffer name.", group)
  defcustom("tmux-cc-pane-buffer-prefix", "string", "tmux-pane ", "Pane buffer prefix.", group)
  defcustom("tmux-cc-pane-history-lines", "number", 200, "History lines to backfill.", group)
  defcustom("tmux-cc-manager-preview-window-size", "number", 12, "Maximum manager preview lines.", group)
  defcustom("tmux-cc-confirm-destructive-actions", "boolean", true, "Confirm destructive manager operations.", group)
  defcustom("tmux-cc-default-command", "string", "tmux -CC attach", "Default control-mode command.", group)
  defcustom("tmux-cc-sync-client-size", "boolean", true, "Synchronize tmux client geometry.", group)
}

function buildPaneMap(): TmuxPaneRawMap {
  const passthrough = new Set((getCustom<string[]>("tmux-cc-passthrough-keys") ?? []).map(normalizeSequence))
  const map = new TmuxPaneRawMap(passthrough)
  const bindCustom = (variable: string, command: string) => {
    const key = getCustom<string>(variable)
    if (key) map.bind(emacsKeySpec(key), command)
  }
  bindCustom("tmux-cc-focus-next-key", "tmux-cc-smart-next-window")
  bindCustom("tmux-cc-focus-prev-key", "tmux-cc-smart-previous-window")
  bindCustom("tmux-cc-focus-other-key", "tmux-cc-focus-next-pane")
  bindCustom("tmux-cc-command-key", "tmux-cc-command")
  bindCustom("tmux-cc-split-horizontal-key", "tmux-cc-split-horizontal")
  bindCustom("tmux-cc-split-vertical-key", "tmux-cc-split-vertical")
  bindCustom("tmux-cc-new-window-key", "tmux-cc-new-window")
  bindCustom("tmux-cc-new-session-key", "tmux-cc-new-session")
  bindCustom("tmux-cc-manager-key", "tmux-cc-manager")
  bindCustom("tmux-cc-switch-window-key", "tmux-cc-switch-window")
  bindCustom("tmux-cc-switch-session-key", "tmux-cc-switch-session")
  bindCustom("tmux-cc-detach-key", "tmux-cc-detach")
  bindCustom("tmux-cc-kill-pane-key", "tmux-cc-kill-pane")
  map.bind("C-c C-c", "tmux-cc-send-control-c")
  map.bind("C-c C-d", "tmux-cc-send-control-d")
  map.bind("C-c C-z", "tmux-cc-send-control-z")
  map.bind("C-c C-\\", "tmux-cc-send-control-backslash")
  map.bind("C-c C-t", "tmux-cc-copy-mode")
  return map
}

function defineTmuxModes(): void {
  defineMode({ name: PANE_MODE, parent: "jterm-mode", keymap: buildPaneMap() })
  const copyMap = new Keymap("tmux-cc-pane-copy-mode-map")
  copyMap.bind("C-c C-t", "tmux-cc-copy-mode")
  copyMap.bind("RET", "tmux-cc-copy-mode-done")
  copyMap.bind("enter", "tmux-cc-copy-mode-done")
  defineMode({ name: PANE_COPY_MODE, parent: "jterm-copy-mode", keymap: copyMap })

  const managerMap = new Keymap("tmux-cc-manager-mode-map")
  managerMap.bind("g", "tmux-cc-manager-refresh")
  managerMap.bind("RET", "tmux-cc-manager-visit")
  managerMap.bind("enter", "tmux-cc-manager-visit")
  managerMap.bind("tab", "tmux-cc-manager-toggle-preview")
  managerMap.bind("h", "tmux-cc-manager-help")
  managerMap.bind("?", "tmux-cc-manager-help")
  managerMap.bind("k", "tmux-cc-manager-delete")
  managerMap.bind("c", "tmux-cc-manager-command")
  managerMap.bind("n", "tmux-cc-manager-new-window")
  managerMap.bind("S-s", "tmux-cc-manager-new-session")
  managerMap.bind("r", "tmux-cc-manager-rename-session")
  managerMap.bind("s", "tmux-cc-switch-session")
  managerMap.bind("w", "tmux-cc-switch-window")
  managerMap.bind("d", "tmux-cc-manager-detach")
  managerMap.bind("q", "bury-buffer")
  defineMode({ name: MANAGER_MODE, parent: "text", keymap: managerMap, onEnter: buffer => { buffer.readOnly = true } })
}

/** In Emacs kbd syntax a bare uppercase letter means Shift+letter. Jemacs's
 *  normalized key syntax spells that S-x, so translate customizable source
 *  bindings while leaving modifiers and shifted punctuation untouched. */
function emacsKeySpec(value: string): string {
  return value.split(/\s+/).map(token => /^[A-Z]$/.test(token) ? `S-${token.toLowerCase()}` : token).join(" ")
}

function state(editor: Editor): TmuxCcController {
  const controller = controllers.get(editor)
  if (!controller) throw new Error("tmux-cc is not installed")
  return controller
}

export async function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): Promise<void> {
  registerCustoms()
  const jterm = await loadJterm()
  defineTmuxModes()
  controllers.get(editor)?.stop("tmux-cc reloaded")
  const controller = new TmuxCcController(editor, jterm)
  controllers.set(editor, controller)

  ctx.command("tmux-cc-start", async ({ editor, args }) => {
    const command = args[0] ?? await editor.prompt("tmux command: ", getCustom<string>("tmux-cc-default-command") ?? "tmux -CC attach", "tmux-cc-command")
    if (command) await state(editor).start(command)
  }, "Start a tmux -CC control client.")
  ctx.command("tmux-cc-stop", ({ editor }) => state(editor).stop(), "Stop the active tmux control client.")
  ctx.command("tmux-cc-command", async ({ editor, args }) => {
    const command = args[0] ?? await editor.prompt("Tmux command: ", "", "tmux-cc-command")
    if (!command) return
    const lines = await state(editor).sendCommand(command)
    editor.message(`tmux: ${lines.join("\n")}`)
  }, "Send an arbitrary command to tmux.")
  ctx.command("tmux-cc-setup-keybindings", () => defineTmuxModes(), "Reapply customizable tmux pane keybindings.")
  ctx.command("tmux-cc-refresh-geometry", async ({ editor }) => state(editor).refreshGeometry(true), "Force JTerm and tmux geometry synchronization.")
  ctx.command("tmux-cc-send-raw", ({ editor, buffer, keyEvent }) => {
    const pane = state(editor).paneForBuffer(buffer)
    if (!pane) return editor.message("Current buffer is not a tmux pane")
    const key = keyEvent ?? editor.lastKeyEvent
    if (key) pane.session.writeRaw(jterm.keyToPtyBytes(key))
  }, "Send the current key to the tmux pane.")
  for (const [name, bytes] of [["c", "\x03"], ["d", "\x04"], ["z", "\x1a"], ["backslash", "\x1c"]] as const) {
    ctx.command(`tmux-cc-send-control-${name}`, ({ editor, buffer }) => {
      state(editor).paneForBuffer(buffer)?.session.writeRaw(bytes)
    }, `Send control-${name} to the tmux pane.`)
  }
  ctx.command("tmux-cc-copy-mode", async ({ editor, buffer }) => state(editor).enterCopyMode(buffer), "Toggle tmux pane copy mode.")
  ctx.command("tmux-cc-copy-mode-done", async ({ editor, buffer }) => state(editor).copyModeDone(buffer), "Copy selection and leave tmux pane copy mode.")

  const currentPane = (ed: Editor) => state(ed).paneForBuffer(ed.currentBuffer)
  ctx.command("tmux-cc-split-horizontal", async ({ editor }) => {
    const pane = currentPane(editor)
    if (!pane) return editor.message("Current buffer is not a tmux pane")
    await state(editor).runAndRefresh(`split-window -h -t ${tmuxQuote(pane.id)}`)
  }, "Split the current tmux pane to the right.")
  ctx.command("tmux-cc-split-vertical", async ({ editor }) => {
    const pane = currentPane(editor)
    if (!pane) return editor.message("Current buffer is not a tmux pane")
    await state(editor).runAndRefresh(`split-window -v -t ${tmuxQuote(pane.id)}`)
  }, "Split the current tmux pane below.")
  ctx.command("tmux-cc-focus-right", ({ editor }) => state(editor).focus("right"), "Focus the tmux pane to the right.")
  ctx.command("tmux-cc-focus-left", ({ editor }) => state(editor).focus("left"), "Focus the tmux pane to the left.")
  ctx.command("tmux-cc-focus-up", ({ editor }) => state(editor).focus("up"), "Focus the tmux pane above.")
  ctx.command("tmux-cc-focus-down", ({ editor }) => state(editor).focus("down"), "Focus the tmux pane below.")
  ctx.command("tmux-cc-focus-next-pane", ({ editor }) => state(editor).focusNext(false), "Focus the next visible tmux pane.")
  ctx.command("tmux-cc-focus-previous-pane", ({ editor }) => state(editor).focusNext(true), "Focus the previous visible tmux pane.")
  ctx.command("tmux-cc-smart-next-window", ({ editor }) => state(editor).smartOtherWindow(1), "Select the next Jemacs window and synchronize tmux focus.")
  ctx.command("tmux-cc-smart-previous-window", ({ editor }) => state(editor).smartOtherWindow(-1), "Select the previous Jemacs window and synchronize tmux focus.")

  ctx.command("tmux-cc-detach", async ({ editor }) => {
    await state(editor).sendCommand("detach-client").catch(() => {})
  }, "Detach the active tmux control client.")
  ctx.command("tmux-cc-switch-session", async ({ editor, args }) => {
    let target: string | undefined = args[0]
    if (!target) {
      const lines = await state(editor).sendCommand("list-sessions -F '#{session_name}'")
      target = await editor.completingRead("Switch to session: ", { collection: lines }) ?? undefined
    }
    if (target) await state(editor).runAndRefresh(`switch-client -t ${tmuxQuote(target)}`)
  }, "Switch tmux sessions.")
  ctx.command("tmux-cc-switch-window", async ({ editor, args }) => {
    let target: string | undefined = args[0]
    if (!target) {
      const lines = await state(editor).sendCommand("list-windows -a -F '#{session_name}:#{window_name}'")
      target = await editor.completingRead("Switch to window: ", { collection: lines }) ?? undefined
    }
    if (target) await state(editor).runAndRefresh(`select-window -t ${tmuxQuote(target)}`)
  }, "Switch tmux windows.")
  ctx.command("tmux-cc-new-window", async ({ editor, args }) => {
    const name = args[0] ?? await editor.prompt("New window name (optional): ", "", "tmux-cc-window")
    await state(editor).runAndRefresh(name ? `new-window -n ${tmuxQuote(name)}` : "new-window")
  }, "Create a new tmux window.")
  ctx.command("tmux-cc-new-session", async ({ editor, args }) => {
    const name = args[0] ?? await editor.prompt("New session name: ", "", "tmux-cc-session")
    if (name) await state(editor).runAndRefresh(`new-session -d -s ${tmuxQuote(name)}`)
  }, "Create a detached tmux session.")
  ctx.command("tmux-cc-kill-pane", async ({ editor, args }) => {
    const paneId = args[0] ?? currentPane(editor)?.id
    if (paneId) await state(editor).runAndRefresh(`kill-pane -t ${tmuxQuote(paneId)}`)
  }, "Kill a tmux pane.")
  ctx.command("tmux-cc-kill-window", async ({ editor, args }) => {
    const id = args[0] ?? await editor.prompt("Window id: ")
    if (id) await state(editor).runAndRefresh(`kill-window -t ${tmuxQuote(id)}`)
  }, "Kill a tmux window.")
  ctx.command("tmux-cc-kill-session", async ({ editor, args }) => {
    const id = args[0] ?? await editor.prompt("Session name: ")
    if (id) await state(editor).runAndRefresh(`kill-session -t ${tmuxQuote(id)}`)
  }, "Kill a tmux session.")
  ctx.command("tmux-cc-rename-session", async ({ editor, args }) => {
    const from = args[0] ?? await editor.prompt("Session name: ")
    const to = args[1] ?? await editor.prompt("New session name: ")
    if (from && to) await state(editor).runAndRefresh(`rename-session -t ${tmuxQuote(from)} ${tmuxQuote(to)}`)
  }, "Rename a tmux session.")

  ctx.command("tmux-cc-manager", async ({ editor }) => {
    state(editor).showManager()
    if (state(editor).running) await state(editor).refreshManager()
  }, "Open the tmux manager.")
  ctx.command("tmux-cc-manager-refresh", async ({ editor }) => state(editor).refreshManager(), "Refresh the tmux manager.")
  ctx.command("tmux-cc-manager-visit", async ({ editor }) => state(editor).visitManagerTarget(), "Visit the manager target at point.")
  ctx.command("tmux-cc-manager-toggle-preview", ({ editor }) => state(editor).togglePreview(), "Toggle inline preview for the target at point.")
  ctx.command("tmux-cc-manager-help", ({ editor }) => state(editor).showManagerHelp(), "Show tmux manager help.")
  ctx.command("tmux-cc-manager-delete", async ({ editor }) => state(editor).deleteManagerTarget(), "Kill the tmux target at point.")
  ctx.command("tmux-cc-manager-command", async ({ editor, args }) => editor.run("tmux-cc-command", args), "Run a tmux command from the manager.")
  ctx.command("tmux-cc-manager-new-window", async ({ editor, args }) => editor.run("tmux-cc-new-window", args), "Create a tmux window from the manager.")
  ctx.command("tmux-cc-manager-new-session", async ({ editor, args }) => editor.run("tmux-cc-new-session", args), "Create a tmux session from the manager.")
  ctx.command("tmux-cc-manager-rename-session", async ({ editor, args }) => {
    const target = state(editor).managerTarget()
    if (target?.type !== "session") return editor.message("Point is not on a tmux session line")
    const name = args[0] ?? await editor.prompt(`Rename session ${target.label} to: `)
    if (name) await state(editor).runAndRefresh(`rename-session -t ${tmuxQuote(target.id)} ${tmuxQuote(name)}`)
  }, "Rename the tmux session at point.")
  ctx.command("tmux-cc-manager-detach", async ({ editor }) => editor.run("tmux-cc-detach"), "Detach from the manager.")

  ctx.hook("window-configuration-change-hook", ({ editor: ed, buffer }) => {
    if (ed === editor && controller.paneForBuffer(buffer)) controller.scheduleGeometry()
  })
  ctx.hook("kill-buffer-hook", ({ editor: ed, buffer }) => {
    if (ed === editor) controller.removePaneForBuffer(buffer)
  })
  ctx.hook("kill-emacs-hook", ({ editor: ed }) => {
    if (ed === editor) controller.stop("Jemacs exited")
  })
  ctx.onDispose(() => {
    controller.stop("tmux-cc unloaded")
    if (controllers.get(editor) === controller) controllers.delete(editor)
  })
}
