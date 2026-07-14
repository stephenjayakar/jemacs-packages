import { describe, expect, test } from "bun:test"
import { Editor, getMode, listWindowLeaves } from "@jemacs/core"
import {
  bytesToHexArgs,
  ControlModeParser,
  decodeTmuxOctal,
  paneIds,
  parseTmuxLayout,
  stripControlModeWrappers,
  tmuxClientExtent,
  tmuxLayoutToWindowTree,
  tmuxQuote,
  TmuxCcController,
  install as installTmuxCc,
} from "./index"
import * as jterm from "../../jemacs-opentui/plugins/jterm/index"

type DataHandler = (chunk: string) => void

class FakeControlTransport {
  readonly pid = 42
  readonly commands: string[] = []
  private dataHandlers: DataHandler[] = []
  private exitHandlers: Array<(code: number | null) => void> = []
  private commandId = 10

  write(data: string): void {
    for (const command of data.trimEnd().split("\n")) {
      this.commands.push(command)
      queueMicrotask(() => this.respond(command))
    }
  }
  resize(): void {}
  onData(fn: DataHandler): void { this.dataHandlers.push(fn) }
  onExit(fn: (code: number | null) => void): void { this.exitHandlers.push(fn) }
  kill(): void {}
  emit(data: string): void { for (const handler of this.dataHandlers) handler(data) }

  private respond(command: string): void {
    const id = String(this.commandId++)
    const lines = command.startsWith("list-sessions")
      ? ["flow\t$0\t1\t1"]
      : command.startsWith("list-windows")
        ? command.includes("-a")
          ? ["flow\tzsh\t@0\t1\tabcd,80x24,0,0,0\t%0"]
          : ["1\t@0\tabcd,80x24,0,0,0"]
        : command.startsWith("list-panes")
          ? ["flow\t@0\t%0\t1\tzsh\t80x24"]
          : command.startsWith("capture-pane")
            ? ["history"]
            : []
    this.emit(`%begin 1 ${id} 1\n${lines.map(line => `${line}\n`).join("")}%end 1 ${id} 1\n`)
  }
}

async function settle(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error(message)
}

describe("tmux-cc protocol", () => {
  test("decodes octal pane output and DCS wrappers across chunks", () => {
    const parser = new ControlModeParser()
    expect(parser.push("\x1bP100")).toEqual([])
    expect(parser.push("0p%output %1 hi\\015\\012there\n")).toEqual([
      { type: "output", paneId: "%1", data: "hi\r\nthere" },
    ])
    expect(stripControlModeWrappers("\x1bP1000p%exit\n\x1b\\")).toBe("%exit\n")
    expect(decodeTmuxOctal("a\\134b\\011c")).toBe("a\\b\tc")
  })

  test("keeps pane output distinct from command response lines", () => {
    const parser = new ControlModeParser()
    expect(parser.push("%begin 1 2 1\n%output %3 x\\012\nresponse\n%end 1 2 1\n")).toEqual([
      { type: "begin", id: "2" },
      { type: "output", paneId: "%3", data: "x\n" },
      { type: "line", line: "response" },
      { type: "end", id: "2" },
    ])
  })

  test("quotes targets and converts Unicode input to UTF-8 hex bytes", () => {
    expect(tmuxQuote("a'b")).toBe("'a'\\''b'")
    expect(bytesToHexArgs("Aé")).toEqual(["41", "C3", "A9"])
  })
})

describe("tmux-cc layouts", () => {
  const source = "b7c7,80x24,0,0{40x24,0,0,1,39x24,41,0[39x12,41,0,2,39x11,41,13,3]}"

  test("parses nested horizontal and vertical tmux groups", () => {
    const layout = parseTmuxLayout(source)
    expect(layout.type).toBe("horizontal")
    expect(paneIds(layout)).toEqual(["%1", "%2", "%3"])
    expect(layout.children[1]?.type).toBe("vertical")
  })

  test("builds a Jemacs window tree with one leaf per pane", () => {
    const editor = new Editor()
    const layout = parseTmuxLayout(source)
    const buffers = new Map(paneIds(layout).map(id => [id, editor.scratch(`pane ${id}`)]))
    const tree = tmuxLayoutToWindowTree(layout, id => buffers.get(id)!, editor.selectedWindowId)
    expect(listWindowLeaves(tree).map(leaf => leaf.bufferId)).toEqual(paneIds(layout).map(id => buffers.get(id)!.id))
    expect(tree.kind).toBe("split")
    if (tree.kind === "split") expect(tree.firstRatio).toBe(0.5)
  })

  test("reconstructs client extent from JTerm body sizes plus tmux separators", () => {
    const layout = parseTmuxLayout(source)
    const dims = new Map([
      ["%1", { rows: 20, cols: 50 }],
      ["%2", { rows: 10, cols: 49 }],
      ["%3", { rows: 9, cols: 49 }],
    ])
    expect(tmuxClientExtent(layout, id => dims.get(id))).toEqual({ rows: 20, cols: 100 })
  })
})

describe("tmux-cc controller", () => {
  test("installs pane-local raw routing without swallowing configured Jemacs passthrough keys", async () => {
    process.env.JEMACS_HOME ??= new URL("../../jemacs-opentui", import.meta.url).pathname
    const editor = new Editor()
    jterm.install(editor)
    await installTmuxCc(editor)
    const map = getMode("tmux-cc-pane-mode")?.keymap
    expect(map?.get("a")).toBe("tmux-cc-send-raw")
    expect(map?.get("M-x")).toBeUndefined()
    expect(map?.get("C-t 2")).toBe("tmux-cc-split-vertical")
    expect(map?.get("C-tab")).toBe("tmux-cc-smart-next-window")
    expect(map?.get("C-t S-s")).toBe("tmux-cc-new-session")
    expect(map?.get("C-t s")).toBe("tmux-cc-switch-session")
  })

  test("bootstraps manager/pane state and routes JTerm input through send-keys", async () => {
    const editor = new Editor()
    jterm.install(editor)
    const control = new FakeControlTransport()
    const module = {
      ...jterm,
      async spawnPtyTransport() { return control },
    }
    const controller = new TmuxCcController(editor, module)
    await controller.start("tmux -CC attach")
    control.emit("\x1bP1000p%begin 1 1 1\n%end 1 1 1\n")
    await settle(() => controller.panes.size === 1, "controller did not create pane")

    const manager = [...editor.buffers.values()].find(buffer => buffer.name === "*tmux-control*")!
    expect(manager.text).toContain("Sessions")
    expect(manager.text).toContain("flow")
    const pane = controller.panes.get("%0")!
    await pane.feedChain
    expect(pane.buffer.text).toContain("history")

    const beforeCopy = pane.buffer.text
    await controller.enterCopyMode(pane.buffer)
    controller.handlePaneOutput("%0", "queued\r\n")
    await Bun.sleep(10)
    expect(pane.buffer.text).toBe(beforeCopy)
    await controller.leaveCopyMode(pane.buffer)
    expect(pane.buffer.text).toContain("queued")

    const oneWindow = listWindowLeaves(editor.windowLayout).length
    controller.handleLayout("@0", "abcd,80x24,0,0{40x24,0,0,0,39x24,41,0,1}")
    expect(listWindowLeaves(editor.windowLayout)).toHaveLength(oneWindow)
    controller.showPane("%0")
    controller.handleLayout("@0", "abcd,80x24,0,0{40x24,0,0,0,39x24,41,0,1}")
    expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)

    pane.session.writeRaw("Aé\r")
    await settle(() => control.commands.some(command => command.includes("send-keys") && command.includes("41 C3 A9 0D")), "JTerm input was not routed to tmux")
    controller.stop("test complete")
    expect(controller.running).toBe(false)
  })
})
