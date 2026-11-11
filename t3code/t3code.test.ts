import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AGY_INSTANCE,
  CLAUDE_INSTANCE,
  FALLBACK_AGY_MODEL,
  newThreadCommands,
  projectAt,
  T3Client,
  threadTitle,
  type T3Project,
} from "./client"
import { normalizeProvider, readLastDirectory, resolveModelSelection, writeLastDirectory } from "./t3code"

const project = (id: string, workspaceRoot: string, deletedAt: string | null = null): T3Project =>
  ({ id, title: id, workspaceRoot, defaultModelSelection: null, deletedAt })

test("threadTitle follows the web client's 50-char truncation", () => {
  expect(threadTitle("  fix the   modeline\n")).toBe("fix the modeline")
  expect(threadTitle("")).toBe("New thread")
  expect(threadTitle("x".repeat(60))).toBe(`${"x".repeat(50)}...`)
})

test("projectAt only matches a live project rooted exactly at the directory", () => {
  const projects = [project("outer", "/w"), project("inner", "/w/app/"), project("gone", "/w/lib", "2026-01-01")]
  expect(projectAt(projects, "/w/app")?.id).toBe("inner")
  expect(projectAt(projects, "/w")?.id).toBe("outer")
  expect(projectAt(projects, "/w/app/src")).toBeUndefined()
  expect(projectAt(projects, "/w/lib")).toBeUndefined()
})

test("the last directory round-trips and is dropped once it no longer exists", () => {
  const root = mkdtempSync(join(tmpdir(), "t3code-state-"))
  const file = join(root, "nested", "state.json")
  expect(readLastDirectory(file)).toBeNull()
  writeLastDirectory(root, file)
  expect(readLastDirectory(file)).toBe(root)
  writeLastDirectory(join(root, "missing"), file)
  expect(readLastDirectory(file)).toBeNull()
  rmSync(root, { recursive: true })
})

test("normalizeProvider maps shorthand aliases", () => {
  expect(normalizeProvider("agy")).toBe(AGY_INSTANCE)
  expect(normalizeProvider("Antigravity")).toBe(AGY_INSTANCE)
  expect(normalizeProvider("claude")).toBe(CLAUDE_INSTANCE)
  expect(normalizeProvider("")).toBe("")
})

test("resolveModelSelection supports both Claude and Antigravity (agy)", () => {
  const opencode = { instanceId: "opencode", model: "x", options: [] }
  const claudeSettings = {
    instanceId: CLAUDE_INSTANCE,
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }, { id: "contextWindow", value: "1m" }],
  }
  const agySettings = {
    instanceId: AGY_INSTANCE,
    model: "gemini-4-carbon",
    options: [{ id: "thought_level", value: "medium" }],
  }

  expect(resolveModelSelection([opencode, claudeSettings], "", "")).toEqual(claudeSettings)
  expect(resolveModelSelection([agySettings, claudeSettings], "", "")).toEqual(agySettings)
  expect(resolveModelSelection([null, opencode], "", "")).toEqual({
    instanceId: CLAUDE_INSTANCE, model: "claude-opus-5-5", options: [],
  })

  // Explicit agy selection falls back to gemini-4-carbon and maps effort to thought_level.
  expect(resolveModelSelection([claudeSettings], "", "", "agy")).toEqual({
    instanceId: AGY_INSTANCE, model: FALLBACK_AGY_MODEL, options: [],
  })
  expect(resolveModelSelection([claudeSettings], "", "high", "agy")).toEqual({
    instanceId: AGY_INSTANCE, model: FALLBACK_AGY_MODEL, options: [{ id: "thought_level", value: "high" }],
  })
  expect(resolveModelSelection([agySettings], "gemini-4-argon", "xhigh", "agy")).toEqual({
    instanceId: AGY_INSTANCE, model: "gemini-4-argon", options: [{ id: "thought_level", value: "high" }],
  })

  // Claude overrides preserve effort across model switches and drop per-model options.
  expect(resolveModelSelection([claudeSettings], "claude-sonnet-5-5", "")).toEqual({
    instanceId: CLAUDE_INSTANCE, model: "claude-sonnet-5-5", options: [{ id: "effort", value: "high" }],
  })
  expect(resolveModelSelection([claudeSettings], "", "max").options).toEqual([
    { id: "contextWindow", value: "1m" },
    { id: "effort", value: "max" },
  ])
})

test("newThreadCommands builds a v2 launchThread payload and adapts auto runtimeMode for agy", () => {
  let n = 0
  const { threadId, launch } = newThreadCommands({
    projectId: "p1",
    prompt: "hello there",
    modelSelection: { instanceId: AGY_INSTANCE, model: FALLBACK_AGY_MODEL },
    runtimeMode: "auto",
    interactionMode: "default",
  }, () => `id${++n}`)
  expect(launch).toMatchObject({
    threadId,
    projectId: "p1",
    title: "hello there",
    generateTitle: true,
    runtimeMode: "auto-accept-edits",
    workspaceStrategy: { type: "root" },
    initialMessage: { text: "hello there", attachments: [] },
  })
  expect(new Set([threadId, launch.commandId, launch.initialMessage.messageId]).size).toBe(3)
})

let server: ReturnType<typeof Bun.serve> | null = null
afterEach(() => {
  server?.stop(true)
  server = null
})

test("T3Client discovers the server, queries /api/projects, and launches threads over /ws", async () => {
  const seenHttp: Array<{ path: string; auth: string | null; body: any }> = []
  const seenRpc: Array<{ tag: string; payload: any }> = []
  server = Bun.serve({
    port: 0,
    async fetch(request, srv) {
      const url = new URL(request.url)
      const path = url.pathname
      if (path === "/ws") {
        if (url.searchParams.get("orchestrationProtocol") !== "2" || url.searchParams.get("wsTicket") !== "ticket-1") {
          return new Response("Unauthorized", { status: 401 })
        }
        if (srv.upgrade(request, { data: undefined })) return undefined
        return new Response("Upgrade failed", { status: 500 })
      }
      const auth = request.headers.get("authorization")
      const raw = request.method === "POST" ? await request.text() : ""
      seenHttp.push({ path, auth, body: raw ? JSON.parse(raw) : null })
      if (auth !== "Bearer secret") return Response.json({ code: "auth_invalid", reason: "missing_credential" }, { status: 401 })
      if (path === "/api/projects") return Response.json({ projects: [project("p1", "/w")] })
      if (path === "/api/projects/mutate") return Response.json(project(seenHttp.at(-1)!.body.projectId, seenHttp.at(-1)!.body.workspaceRoot))
      if (path === "/api/auth/websocket-ticket/rpc") return Response.json({ ticket: "ticket-1", expiresAt: "2099-01-01T00:00:00Z" })
      return new Response("Not found", { status: 404 })
    },
    websocket: {
      message(ws, message) {
        const req = JSON.parse(String(message))
        seenRpc.push({ tag: req.tag, payload: req.payload })
        ws.send(JSON.stringify({
          _tag: "Exit",
          requestId: req.id,
          exit: { _tag: "Success", value: { threadId: req.payload.threadId, resumed: false } },
        }))
      },
    },
  })
  const baseDir = mkdtempSync(join(tmpdir(), "t3code-base-"))
  mkdirSync(join(baseDir, "userdata"))
  writeFileSync(join(baseDir, "userdata", "server-runtime.json"), JSON.stringify({ origin: `http://127.0.0.1:${server.port}` }))

  const client = new T3Client({ baseDir, appPath: "/nonexistent.app", tokenFile: join(baseDir, "token.json"), token: "secret" })
  expect((await client.snapshot()).projects[0]!.id).toBe("p1")
  const { threadId } = await client.startThread({
    projectId: "p1",
    prompt: "go agy",
    modelSelection: { instanceId: AGY_INSTANCE, model: FALLBACK_AGY_MODEL },
    runtimeMode: "full-access",
    interactionMode: "default",
  })
  expect(seenRpc).toHaveLength(1)
  expect(seenRpc[0]!.tag).toBe("orchestration.launchThread")
  expect(seenRpc[0]!.payload).toMatchObject({
    threadId,
    projectId: "p1",
    modelSelection: { instanceId: AGY_INSTANCE, model: FALLBACK_AGY_MODEL },
    initialMessage: { text: "go agy" },
  })

  const rejected = new T3Client({ baseDir, appPath: "/nonexistent.app", tokenFile: join(baseDir, "token.json"), token: "wrong" })
  await expect(rejected.snapshot()).rejects.toThrow("401 auth_invalid: missing_credential")
  rmSync(baseDir, { recursive: true })
})

test("T3Client reports when T3 Code isn't running", async () => {
  const client = new T3Client({ baseDir: "/nonexistent", appPath: "/nonexistent.app", tokenFile: "/nonexistent/t", token: "x" })
  await expect(client.snapshot()).rejects.toThrow("T3 Code isn't running")
})
