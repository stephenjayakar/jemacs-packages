import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Editor, setCustom } from "@jemacs/core"
import { install } from "./dap-mode"
import { dapAdapter, dapTaskProvider, registerDapAdapter, registerDapDebugTemplate } from "./api"
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
  test("auto-configure honors the selected feature set", async () => {
    const editor = new Editor()
    install(editor)
    setCustom("dap-auto-configure-features", ["sessions"])
    editor.disableMinorMode("dap-auto-configure-mode")
    editor.enableMinorMode("dap-auto-configure-mode")
    await Bun.sleep(10)
    expect(editor.isMinorModeEnabled("dap-ui-many-windows-mode")).toBe(true)
    expect(editor.isMinorModeEnabled("dap-ui-controls-mode")).toBe(false)
    expect(editor.isMinorModeEnabled("dap-tooltip-mode")).toBe(false)
    setCustom("dap-auto-configure-features", ["sessions", "locals", "breakpoints", "expressions", "controls", "tooltip"])
  })

  test("rejects unsupported ptvsd instead of silently changing the Python debugger", () => {
    const editor = new Editor()
    install(editor)
    setCustom("dap-python-debugger", "ptvsd")
    expect(() => dapAdapter("debugpy")!.resolve({ name: "python", type: "debugpy", request: "launch" }, {
      projectRoot: "/tmp", workspaceFolders: {}, cwd: "/tmp", env: () => undefined, configValues: {},
    })).toThrow("ptvsd")
    setCustom("dap-python-debugger", "debugpy")
  })

  test("discovers and runs a VS Code tasks.json pre-launch task", async () => {
    const root = await mkdtemp(join(tmpdir(), "jemacs-dap-task-"))
    temporaryPaths.push(root)
    await mkdir(join(root, ".vscode"), { recursive: true })
    await writeFile(join(root, ".vscode", "tasks.json"), JSON.stringify({ version: "2.0.0", tasks: [{ label: "prepare", command: "true" }] }))
    const editor = new Editor()
    install(editor)
    const provider = dapTaskProvider()
    expect(provider).toBeDefined()
    await provider!.run("prepare", { projectRoot: root, workspaceFolders: {}, cwd: root, env: () => undefined, configValues: {} })
  })

  test("registered debug templates participate in dap-debug selection", async () => {
    const dispose = registerDapDebugTemplate("Template :: fake", { name: "ignored", type: "fake", request: "launch", program: "/tmp/fake" })
    try {
      const editor = new Editor()
      install(editor)
      const root = await mkdtemp(join(tmpdir(), "jemacs-dap-template-"))
      temporaryPaths.push(root)
      await editor.openFile(join(root, "main.ts"))
      let choices: string[] = []
      editor.completingRead = async (_prompt, options) => { choices = [...(options.collection ?? [])]; return null }
      await editor.run("dap-debug")
      expect(choices).toContain("Template :: fake")
    } finally { dispose() }
  })

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
    for (const command of [
      "dap-debug-edit-template", "dap-go-to-output-buffer", "dap-delete-session", "dap-delete-all-sessions",
      "dap-stop-thread", "dap-mode-mouse-set-clear-breakpoint", "dap-tooltip-at-point", "dap-tooltip-mouse-motion",
      "dap-ui-breakpoints-goto", "dap-ui-breakpoints-delete", "dap-ui-breakpoints-browse", "dap-ui-breakpoints-delete-selected", "dap-ui-breakpoints-list",
      "dap-ui-eval-in-buffer", "dap-ui-eval-variable-in-buffer", "dap-ui-expressions-add-prompt", "dap-ui-expressions-remove", "dap-ui-expressions-refresh",
      "dap-ui-loaded-sources", "dap-ui-repl-company",
    ]) expect(editor.commands.get(command)).toBeDefined()
    expect(editor.gutterDecorations(buffer).map(item => item.line)).toEqual([2, 4])
    buffer.splice(0, 0, "# inserted above the breakpoints\n")
    await Bun.sleep(0)
    expect(editor.gutterDecorations(buffer).map(item => item.line)).toEqual([3, 5])
    await buffer.save({ runHook: (name, target) => editor.runHook(name, target) })
    const rewrittenGNUStore = await readFile(breakpoints, "utf8")
    expect(rewrittenGNUStore).toContain(":point")
    expect(rewrittenGNUStore).toContain(`:point ${point2 + "# inserted above the breakpoints\n".length}`)
    buffer.splice(0, "# inserted above the breakpoints\n".length, "")
    await Bun.sleep(0)
    expect(editor.gutterDecorations(buffer).map(item => item.line)).toEqual([2, 4])
    await buffer.save({ runHook: (name, target) => editor.runHook(name, target) })
    const restarted = new Editor()
    install(restarted)
    const restartedBuffer = await restarted.openFile(source)
    for (let attempt = 0; attempt < 50 && restarted.gutterDecorations(restartedBuffer).length < 2; attempt++) await Bun.sleep(10)
    expect(restarted.gutterDecorations(restartedBuffer).map(item => item.line)).toEqual([2, 4])

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
    let loadedSourcesChanged = 0
    let executed = 0
    const session = new DapSession("fake", config, { kind: "stdio", command: [process.execPath, fixture] }, {
      breakpoints: () => [{ id: "bp", path: "/tmp/fake.ts", line: 4, enabled: true }],
      loadedSourcesChanged: () => { loadedSourcesChanged++ },
      executed: () => { executed++ },
      changed: () => {},
    })
    await session.start()
    expect(session.loadedSources[0]?.sourceReference).toBe(77)
    expect(loadedSourcesChanged).toBe(1)
    expect((await session.source(77)).content).toContain("virtual source")
    expect((await session.completions("ans"))[0]?.label).toBe("answer")
    await session.pause()
    for (let attempt = 0; attempt < 50 && !session.selectedFrame; attempt++) await Bun.sleep(10)
    expect(session.selectedFrame?.line).toBe(4)
    expect(session.scopes[0]?.variables[0]?.value).toBe("42")
    expect(session.scopes[0]?.variables[1]?.variablesReference).toBe(21)
    expect((await session.setVariable(20, "answer", "43")).value).toBe("43")
    await session.stopThread()
    expect((await session.evaluate("answer")).result).toBe("42")
    await session.continue()
    expect(executed).toBeGreaterThanOrEqual(2)
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
      expect([...editor.buffers.values()].filter(buffer => buffer.name.startsWith("*dap-output:")).length).toBe(2)
      await editor.run("dap-go-to-output-buffer")
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
