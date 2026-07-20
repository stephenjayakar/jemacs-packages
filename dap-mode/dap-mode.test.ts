import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Editor, setCustom } from "@jemacs/core"
import { install } from "./dap-mode"
import { registerDapAdapter } from "./api"
import { DapConnection } from "./connection"
import { ContentLengthMessageParser, serializeContentLength } from "./content-length"
import { expandLaunchConfiguration, parseLaunchJson } from "./config"
import { DapSession } from "./session"
import type { DapContext, DapLaunchConfiguration, DapMessage } from "./types"

const temporaryPaths: string[] = []
afterAll(async () => { await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true }))) })

describe("dap-mode protocol and launch configuration", () => {
  test("frames fragmented UTF-8 messages and matches responses", async () => {
    const parser = new ContentLengthMessageParser<{ value: string }>()
    const framed = serializeContentLength({ value: "héllo" })
    expect(parser.feed(framed.slice(0, 9))).toEqual([])
    expect(parser.feed(framed.slice(9))).toEqual([{ value: "héllo" }])

    const sent: string[] = []
    const messages = new ContentLengthMessageParser<DapMessage>()
    const connection = new DapConnection(payload => sent.push(payload))
    const pending = connection.request("threads")
    const request = messages.feed(sent.shift()!)[0]!
    connection.feed(serializeContentLength({ seq: 2, type: "response", request_seq: request.seq, command: "threads", success: true, body: { threads: [] } }))
    expect(await pending).toEqual({ threads: [] })
  })

  test("parses JSONC and expands launch variables", async () => {
    const launch = parseLaunchJson(`{"version":"0.2.0","configurations":[{"name":"Python","type":"debugpy","request":"launch","program":"\${file}",},],}`)
    const context: DapContext = { projectRoot: "/work", workspaceFolders: { work: "/work" }, file: "/work/main.py", cwd: "/work", env: () => undefined, configValues: {} }
    const editor = new Editor()
    expect(await expandLaunchConfiguration(editor, launch.configurations[0]!, launch, context)).toMatchObject({ program: "/work/main.py" })
  })
})

describe("GNU dap-mode parity", () => {
  test("imports GNU breakpoint points, enables Stephen's modes, and renders the many-window layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "jemacs-dap-mode-"))
    temporaryPaths.push(root)
    const source = join(root, "main.py")
    await writeFile(source, "def fibo(n):\n    if n <= 0:\n        return 0\n    return fibo(n - 1)\n")
    const point2 = "def fibo(n):\n".length + 1
    const point4 = "def fibo(n):\n    if n <= 0:\n        return 0\n".length + 1
    const breakpoints = join(root, ".dap-breakpoints")
    await writeFile(breakpoints, `#s(hash-table data ("${source}" ((:point ${point2}) (:point ${point4}))))`)
    install(new Editor())
    setCustom("dap-state-file", join(root, "state.json"))
    setCustom("dap-breakpoints-file", breakpoints)

    const editor = new Editor()
    install(editor)
    const buffer = await editor.openFile(source)
    for (let attempt = 0; attempt < 50 && editor.gutterDecorations(buffer).length < 2; attempt++) await Bun.sleep(10)

    expect(editor.isMinorModeEnabled("dap-auto-configure-mode")).toBe(true)
    expect(editor.isMinorModeEnabled("dap-mode")).toBe(true)
    expect(editor.commands.get("dap-breakpoint-toggle")).toBeDefined()
    expect(editor.commands.get("dap-debug")).toBeDefined()
    expect(editor.gutterDecorations(buffer).map(item => item.line)).toEqual([2, 4])
    buffer.splice(0, 0, "# inserted above the breakpoints\n")
    await Bun.sleep(0)
    expect(editor.gutterDecorations(buffer).map(item => item.line)).toEqual([3, 5])
    await buffer.save({ runHook: (name, target) => editor.runHook(name, target) })
    const rewrittenGNUStore = await readFile(breakpoints, "utf8")
    expect(rewrittenGNUStore).toContain(":point")
    expect(rewrittenGNUStore).toContain(`:point ${point2 + "# inserted above the breakpoints\n".length}`)

    let templates: string[] = []
    editor.completingRead = async (_prompt, options) => { templates = [...(options.collection ?? [])]; return null }
    await editor.run("dap-debug")
    expect(templates).toEqual([
      "Python :: Run file (buffer)",
      "Python :: Run pytest (buffer)",
      "Python :: Run pytest (at point)",
      "Python :: Attach to running process",
      "Python :: Run file from project directory",
    ])

    const original = editor.currentWindowConfiguration()
    await editor.run("dap-ui-show-many-windows")
    for (const name of ["*dap-ui-breakpoints*", "*dap-ui-locals*", "*dap-ui-expressions*", "*dap-ui-sessions*"]) {
      expect([...editor.buffers.values()].some(candidate => candidate.name === name)).toBe(true)
    }
    await editor.run("dap-ui-hide-many-windows")
    expect(editor.windowLayout).toEqual(original.layout)
  })
})

describe("DAP session", () => {
  test("initializes, stops at a frame, evaluates, continues, and disconnects", async () => {
    const fixture = join(import.meta.dir, "fixtures", "fake-dap-adapter.ts")
    const config: DapLaunchConfiguration = { name: "fake", type: "fake", request: "launch", program: "/tmp/fake.ts" }
    const session = new DapSession("fake", config, { kind: "stdio", command: [process.execPath, fixture] }, {
      breakpoints: () => [{ id: "bp", path: "/tmp/fake.ts", line: 4, enabled: true }],
      changed: () => {},
    })
    await session.start()
    await session.pause()
    for (let attempt = 0; attempt < 50 && !session.selectedFrame; attempt++) await Bun.sleep(10)
    expect(session.selectedFrame?.line).toBe(4)
    expect(session.scopes[0]?.variables[0]?.value).toBe("42")
    expect((await session.evaluate("answer")).result).toBe("42")
    await session.continue()
    expect(session.state).toBe("running")
    await session.disconnect()
    expect(session.state).toBe("terminated")
  })

  test("compound sessions keep stepping scoped to the selected current session", async () => {
    const root = await mkdtemp(join(tmpdir(), "jemacs-dap-compound-"))
    temporaryPaths.push(root)
    const source = join(root, "main.ts")
    const log = join(root, "adapter.log")
    await writeFile(source, "console.log(1)\n")
    await mkdir(join(root, ".vscode"), { recursive: true })
    await writeFile(join(root, ".vscode", "launch.json"), JSON.stringify({
      version: "0.2.0",
      configurations: [
        { name: "one", type: "fake-test", request: "launch", program: source },
        { name: "two", type: "fake-test", request: "launch", program: source },
      ],
      compounds: [{ name: "both", configurations: ["one", "two"] }],
    }))
    const disposeAdapter = registerDapAdapter({
      types: ["fake-test"],
      resolve: () => ({ kind: "stdio", command: [process.execPath, join(import.meta.dir, "fixtures", "fake-dap-adapter.ts")], cwd: root, env: { FAKE_DAP_LOG: log } }),
    })
    try {
      const editor = new Editor()
      install(editor)
      await editor.openFile(source)
      editor.completingRead = async () => "both"
      await editor.run("dap-debug")
      await Bun.sleep(100)
      editor.completingRead = async () => "two"
      await editor.run("dap-switch-session")
      await editor.run("dap-pause")
      await Bun.sleep(100)
      const pauseCount = (await readFile(log, "utf8")).split("\n").filter(line => line.endsWith(" pause")).length
      expect(pauseCount).toBe(1)
      await editor.run("dap-debug-restart")
      await Bun.sleep(150)
      const launchCount = (await readFile(log, "utf8")).split("\n").filter(line => line.endsWith(" launch")).length
      expect(launchCount).toBe(3)
      await editor.run("dap-delete-all-sessions")
    } finally {
      disposeAdapter()
    }
  })
})
