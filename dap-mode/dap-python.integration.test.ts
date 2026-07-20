import { describe, expect, test } from "bun:test"
import { dirname } from "node:path"
import { whichExecutable } from "@jemacs/core"
import { DapSession } from "./session"
import type { DapSourceBreakpoint } from "./types"

const enabled = process.env.DAP_INTEGRATION === "1"
const source = process.env.DAP_TEST_FILE ?? "/Users/stephen/programming/vibe/temp/main.py"

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe.skipIf(!enabled)("real dap-python/debugpy", () => {
  test("stops at imported breakpoints, steps, and continues", async () => {
    const python = whichExecutable("python") ?? whichExecutable("python3")
    if (!python) throw new Error("python is unavailable")
    const breakpoints: DapSourceBreakpoint[] = [
      { id: "line-2", path: source, line: 2, enabled: true },
      { id: "line-5", path: source, line: 5, enabled: true },
    ]
    const session = new DapSession("Python :: Run file (buffer)", {
      name: "Python :: Run file (buffer)",
      type: "debugpy",
      request: "launch",
      program: source,
      cwd: dirname(source),
      console: "internalConsole",
      justMyCode: true,
    }, {
      kind: "stdio",
      command: [python, "-m", "debugpy.adapter"],
      cwd: dirname(source),
    }, {
      breakpoints: () => breakpoints,
      changed: () => {},
    })

    try {
      await session.start()
      await waitFor(() => session.state === "stopped" && session.selectedFrame != null, "first breakpoint")
      expect(session.selectedFrame?.line).toBe(2)
      expect(breakpoints.every(breakpoint => breakpoint.verified === true)).toBe(true)

      await session.next()
      await waitFor(() => session.state === "stopped" && session.selectedFrame?.line === 4, "step over to line 4")

      await session.continue()
      for (let attempt = 0; attempt < 12; attempt++) {
        await waitFor(() => session.state === "stopped" || session.state === "terminated", "next breakpoint")
        if (session.state === "terminated" || session.selectedFrame?.line === 2) break
        await session.continue()
      }
      expect(session.state).toBe("stopped")
      expect(session.selectedFrame?.line).toBe(2)
      expect(session.scopes.flatMap(scope => scope.variables).find(variable => variable.name === "n")?.value).toBe("9")
    } finally {
      await session.disconnect().catch(() => {})
    }
  }, 30_000)
})
