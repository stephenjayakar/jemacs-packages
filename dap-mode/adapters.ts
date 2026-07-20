import { join } from "node:path"
import { env, fileExists, findFreeTcpPort, getCustom, homedir, readdir, whichExecutable } from "@jemacs/core"
import { registerDapAdapter } from "./api"
import type { DapAdapterDescriptor } from "./types"

async function discoverJsDebug(): Promise<string | null> {
  const explicit = env("JEMACS_JS_DEBUG_PATH") ?? getCustom<string>("dap-node-adapter-path")
  if (explicit && await fileExists(explicit)) return explicit
  const roots = [
    join(homedir(), ".vscode", "extensions"),
    join(homedir(), ".vscode-insiders", "extensions"),
    join(homedir(), ".cursor", "extensions"),
  ]
  const candidates: string[] = []
  for (const root of roots) {
    for (const entry of await readdir(root).catch(() => [])) {
      if (!entry.startsWith("ms-vscode.js-debug")) continue
      candidates.push(join(root, entry, "src", "dapDebugServer.js"))
    }
  }
  const application = "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/ms-vscode.js-debug/src/dapDebugServer.js"
  candidates.push(application)
  for (const candidate of candidates.sort().reverse()) if (await fileExists(candidate)) return candidate
  return null
}

export function installBuiltinDapAdapters(): () => void {
  const disposers: Array<() => void> = []
  const python: DapAdapterDescriptor = {
    types: ["debugpy", "python"],
    resolve(_config, context) {
      const selectedDebugger = getCustom<string>("dap-python-debugger") ?? "debugpy"
      if (selectedDebugger !== "debugpy") throw new Error(`Unsupported dap-python debugger ${selectedDebugger}; Jemacs supports debugpy (ptvsd is not installed)`)
      const command = getCustom<string>("dap-python-executable") ?? "python"
      const executable = whichExecutable(command)
      if (!executable) throw new Error(`Python debugger unavailable: ${command} is not on PATH`)
      return { kind: "stdio", command: [executable, "-m", "debugpy.adapter"], cwd: context.projectRoot }
    },
  }
  const node: DapAdapterDescriptor = {
    types: ["pwa-node", "node"],
    async resolve(_config, context) {
      const adapter = await discoverJsDebug()
      if (!adapter) {
        throw new Error("JavaScript debugger unavailable: set dap-node-adapter-path or JEMACS_JS_DEBUG_PATH to js-debug/src/dapDebugServer.js")
      }
      const nodeCommand = getCustom<string>("dap-node-command") ?? "node"
      const executable = whichExecutable(nodeCommand)
      if (!executable) throw new Error(`JavaScript debugger unavailable: ${nodeCommand} is not on PATH`)
      const port = await findFreeTcpPort()
      return {
        kind: "tcp",
        host: "127.0.0.1",
        port,
        process: [executable, adapter, String(port)],
        cwd: context.projectRoot,
      }
    },
  }
  disposers.push(registerDapAdapter(python), registerDapAdapter(node))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
