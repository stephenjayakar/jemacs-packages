import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { Editor } from "@jemacs/core"
import { controllerFor, install } from "./index"

const socket = `jemacs-tmux-cc-${process.pid}`
const hasPty = spawnSync("python3", ["-c", "import os,pty; m,s=pty.openpty(); os.close(m); os.close(s)"], { stdio: "ignore" }).status === 0

afterEach(() => {
  spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" })
})

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(25)
  }
  throw new Error(message)
}

test.skipIf(!hasPty)("tmux-cc live control client renders JTerm output, manages panes, and detaches", async () => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) return
  process.env.JEMACS_HOME ??= new URL("../../jemacs-opentui", import.meta.url).pathname
  const jterm = await import("../../jemacs-opentui/plugins/jterm/index")
  const editor = new Editor()
  jterm.install(editor)
  await install(editor)
  const controller = controllerFor(editor)!

  await controller.start(`tmux -L ${socket} -CC -f /dev/null new-session -A -s flow`)
  await waitUntil(() => controller.running && controller.panes.size === 1, "tmux-cc did not attach and create its first pane")
  await waitUntil(() => [...editor.buffers.values()].some(buffer => buffer.name === "*tmux-control*" && buffer.text.includes("Sessions")), "manager did not render")

  const first = [...controller.panes.values()][0]!
  controller.showPane(first.id)
  first.session.writeRaw("printf 'JTERM_TMUX_OK\\n'\r")
  await waitUntil(() => first.buffer.text.includes("JTERM_TMUX_OK"), "pane output did not reach JTerm")

  await controller.runAndRefresh(`split-window -h -t '${first.id}'`)
  await waitUntil(() => controller.panes.size === 2, "tmux split did not create a second JTerm pane")
  await controller.refreshManager()
  const manager = [...editor.buffers.values()].find(buffer => buffer.name === "*tmux-control*")!
  expect(manager.text).toContain("Panes")
  expect(manager.text.match(/%\d+/g)?.length).toBeGreaterThanOrEqual(2)

  await controller.sendCommand("detach-client")
  await waitUntil(() => !controller.running, "detach did not close the control client")
}, 20_000)
