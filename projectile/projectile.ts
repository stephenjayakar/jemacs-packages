import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

type Editor = import("../../jemacs-opentui/src/kernel/editor").Editor
type BufferModel = import("../../jemacs-opentui/src/kernel/buffer").BufferModel

type FindFileOp = (editor: Editor, path: string) => Promise<void>

type ProjectileDeps = {
  addHook: typeof import("../../jemacs-opentui/src/kernel/hooks").addHook
  Keymap: typeof import("../../jemacs-opentui/src/kernel/keymap").Keymap
  defineMinorMode: typeof import("../../jemacs-opentui/src/modes/minor-mode").defineMinorMode
  spawnProcess: typeof import("../../jemacs-opentui/src/platform/runtime").spawnProcess
  defcustom: typeof import("../../jemacs-opentui/src/runtime/custom").defcustom
  getCustom: typeof import("../../jemacs-opentui/src/runtime/custom").getCustom
  compilationStart: typeof import("../../jemacs-opentui/plugins/compile").compilationStart
  lastCompileCommand: typeof import("../../jemacs-opentui/plugins/compile").lastCompileCommand
}

const ROOT_MARKERS_BOTTOM_UP = [
  ".git", ".hg", ".fslckout", "_FOSSIL_", ".bzr", "_darcs", ".pijul", ".sl", ".jj",
]
const ROOT_MARKERS_TOP = [
  "GTAGS", "TAGS", "configure.ac", "configure.in", "cscope.out",
]

const projectRootCache = new Map<string, string | null>()
const projectsCache = new Map<string, string[]>()

let knownProjects: string[] | null = null

/** Test-only: clear module caches between cases. */
export function resetProjectileStateForTests(): void {
  knownProjects = null
  projectRootCache.clear()
  projectsCache.clear()
}

function jemacsHome(): string {
  return process.env.JEMACS_HOME ?? join(homedir(), "programming", "jemacs", "jemacs-opentui")
}

function jemacsDir(): string {
  return join(homedir(), ".jemacs")
}

function knownProjectsFile(getCustom: ProjectileDeps["getCustom"]): string {
  return getCustom<string>("projectile-known-projects-file")
    ?? join(jemacsDir(), "projectile-bookmarks.json")
}

function keymapPrefix(getCustom: ProjectileDeps["getCustom"]): string {
  return getCustom<string>("projectile-keymap-prefix") ?? "C-c p"
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

async function locateDominatingFile(start: string, marker: string): Promise<string | null> {
  let dir = resolve(start)
  const root = resolve("/")
  while (dir !== root) {
    if (await pathExists(join(dir, marker))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function rootTopDown(dir: string): Promise<string | null> {
  for (const marker of ROOT_MARKERS_TOP) {
    const found = await locateDominatingFile(dir, marker)
    if (found) return found
  }
  return null
}

async function rootBottomUp(dir: string): Promise<string | null> {
  for (const marker of ROOT_MARKERS_BOTTOM_UP) {
    const found = await locateDominatingFile(dir, marker)
    if (found) return found
  }
  return null
}

async function rootMarked(dir: string): Promise<string | null> {
  return (await pathExists(join(dir, ".projectile"))) ? dir : null
}

/** `projectile-project-root` */
export async function projectileProjectRoot(dir?: string): Promise<string | null> {
  const start = resolve(dir ?? process.cwd())
  const cached = projectRootCache.get(start)
  if (cached !== undefined) return cached

  for (const fn of [rootMarked, rootTopDown, rootBottomUp]) {
    const value = await fn(start)
    if (value) {
      projectRootCache.set(start, value)
      return value
    }
  }
  projectRootCache.set(start, null)
  return null
}

export async function projectileProjectFiles(
  projectRoot: string,
  spawnProcess: ProjectileDeps["spawnProcess"],
  getCustom: ProjectileDeps["getCustom"],
): Promise<string[]> {
  const root = resolve(projectRoot)
  if (getCustom<boolean>("projectile-enable-caching")) {
    const cached = projectsCache.get(root)
    if (cached) return [...cached]
  }

  const proc = spawnProcess({ cmd: ["git", "ls-files", "-z"], cwd: root, stdout: "pipe", stderr: "pipe" })
  const out = proc.stdout ? await new Response(proc.stdout).text() : ""
  await proc.exited
  const files = out.split("\0").filter(Boolean).sort()

  if (getCustom<boolean>("projectile-enable-caching")) {
    projectsCache.set(root, files)
  }
  return files
}

function invalidateProjectCaches(root?: string): void {
  projectRootCache.clear()
  if (root) projectsCache.delete(resolve(root))
  else projectsCache.clear()
}

async function readKnownProjectsFile(getCustom: ProjectileDeps["getCustom"]): Promise<string[]> {
  const text = await readFile(knownProjectsFile(getCustom), "utf8").catch(() => null)
  if (!text) return []
  try {
    const data = JSON.parse(text) as unknown
    return Array.isArray(data) ? data.map(String).map(p => resolve(p)) : []
  } catch {
    return []
  }
}

async function saveKnownProjects(getCustom: ProjectileDeps["getCustom"]): Promise<void> {
  const file = knownProjectsFile(getCustom)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(knownProjects ?? [], null, 2), "utf8")
}

export async function projectileKnownProjects(getCustom: ProjectileDeps["getCustom"]): Promise<string[]> {
  if (!knownProjects) knownProjects = await readKnownProjectsFile(getCustom)
  return [...knownProjects]
}

export async function projectileAddKnownProject(
  root: string,
  getCustom: ProjectileDeps["getCustom"],
): Promise<void> {
  const dir = resolve(root)
  if (getCustom<string[]>("projectile-ignored-projects")?.includes(dir)) return
  const list = await projectileKnownProjects(getCustom)
  const i = list.indexOf(dir)
  if (i === 0) return
  if (i > 0) list.splice(i, 1)
  list.unshift(dir)
  knownProjects = list
  await saveKnownProjects(getCustom)
}

function projectileDefaultProjectName(root: string): string {
  return basename(resolve(root)) || root
}

function projectileProjectName(root: string | null, getCustom: ProjectileDeps["getCustom"]): string {
  const custom = getCustom<string>("projectile-project-name")
  if (custom) return custom
  if (root) return projectileDefaultProjectName(root)
  return "-"
}

function prependProjectName(
  prompt: string,
  root: string | null,
  getCustom: ProjectileDeps["getCustom"],
): string {
  if (!root) return prompt
  return `[${projectileProjectName(root, getCustom)}] ${prompt}`
}

async function projectileCompletingRead(
  editor: Editor,
  prompt: string,
  collection: string[],
  root: string | null,
  getCustom: ProjectileDeps["getCustom"],
  history?: string,
): Promise<string | null> {
  return editor.completingRead(prependProjectName(prompt, root, getCustom), {
    collection,
    history: history ?? "projectile",
  })
}

async function startDir(editor: Editor, override?: string): Promise<string> {
  return override ?? editor.currentBuffer.directory() ?? process.cwd()
}

async function acquireRoot(
  editor: Editor,
  getCustom: ProjectileDeps["getCustom"],
  override?: string,
): Promise<string | null> {
  const start = await startDir(editor, override)
  const root = await projectileProjectRoot(start)
  if (root) return root

  const requireRoot = getCustom<boolean | "prompt">("projectile-require-project-root")
  if (requireRoot === "prompt") {
    const projects = await projectileKnownProjects(getCustom)
    if (!projects.length) {
      editor.message("There are no known projects")
      return null
    }
    return projectileCompletingRead(editor, "Switch to project: ", projects, null, getCustom, "projectile-project")
  }
  if (requireRoot === true) {
    editor.message(`Projectile cannot find a project definition in ${start}`)
    return null
  }
  return start
}

function maybeInvalidateCache(force: number | boolean | null | undefined, root: string): void {
  if (force != null) invalidateProjectCaches(root)
}

function allBuffers(editor: Editor): BufferModel[] {
  return [...editor.buffers.values()]
}

async function openFindFile(
  editor: Editor,
  deps: ProjectileDeps,
  invalidate: number | boolean | null | undefined,
  open: FindFileOp,
  override?: string,
): Promise<void> {
  const { getCustom, spawnProcess } = deps
  const root = await acquireRoot(editor, getCustom, override)
  if (!root) return
  maybeInvalidateCache(invalidate, root)
  await projectileAddKnownProject(root, getCustom)
  const files = await projectileProjectFiles(root, spawnProcess, getCustom)
  if (!files.length) {
    editor.message(`No tracked files in ${root}`)
    return
  }
  const choice = await projectileCompletingRead(editor, "Find file: ", files, root, getCustom, "projectile-file")
  if (!choice) return
  await open(editor, join(root, choice))
  await editor.runHook("projectile-find-file-hook", editor.currentBuffer)
}

function filenameAtPoint(buffer: BufferModel): string {
  const text = buffer.text
  const offset = buffer.point
  const re = /[\w./@~+-]+(?:\.[\w.-]+)?/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const start = match.index
    const end = start + match[0].length
    if (offset >= start && offset <= end) return match[0]
  }
  return ""
}

function selectDwimFiles(files: string[], needle: string): string[] {
  if (!needle) return []
  const normalized = needle.replace(/^\.\//, "")
  return files.filter(f => f.includes(normalized))
}

async function findFileDwim(
  editor: Editor,
  deps: ProjectileDeps,
  invalidate: number | boolean | null | undefined,
  open: FindFileOp,
  override?: string,
): Promise<void> {
  const { getCustom, spawnProcess } = deps
  const root = await acquireRoot(editor, getCustom, override)
  if (!root) return
  maybeInvalidateCache(invalidate, root)
  const files = await projectileProjectFiles(root, spawnProcess, getCustom)
  const needle = filenameAtPoint(editor.currentBuffer)
  const matches = selectDwimFiles(files, needle)
  let choice: string | null
  if (matches.length === 1) choice = matches[0]!
  else if (matches.length > 1) {
    choice = await projectileCompletingRead(editor, "Switch to: ", matches, root, getCustom, "projectile-file")
  } else {
    choice = await projectileCompletingRead(editor, "Switch to: ", files, root, getCustom, "projectile-file")
  }
  if (!choice) return
  await open(editor, join(root, choice))
  await editor.runHook("projectile-find-file-hook", editor.currentBuffer)
}

async function switchProjectByName(
  editor: Editor,
  project: string,
  commander: boolean,
  getCustom: ProjectileDeps["getCustom"],
): Promise<void> {
  const root = resolve(project)
  if (!(await projectileProjectRoot(root))) {
    knownProjects = (await projectileKnownProjects(getCustom)).filter(p => p !== root)
    await saveKnownProjects(getCustom)
    editor.message(`Directory ${root} is not a project`)
    return
  }
  await editor.runHook("projectile-before-switch-project-hook", editor.currentBuffer)
  const action = commander
    ? "projectile-commander"
    : (getCustom<string>("projectile-switch-project-action") ?? "projectile-find-file")
  await editor.run(action, [root])
  await editor.runHook("projectile-after-switch-project-hook", editor.currentBuffer)
}

function projectBufferFiles(editor: Editor, root: string): BufferModel[] {
  const resolved = resolve(root)
  return allBuffers(editor).filter(buf => {
    const dir = buf.directory()
    return dir != null && (dir === resolved || dir.startsWith(resolved + "/"))
  })
}

async function openProjects(editor: Editor): Promise<string[]> {
  const seen = new Set<string>()
  const out: string[] = []
  for (const buf of allBuffers(editor)) {
    const dir = buf.directory()
    if (!dir) continue
    const root = await projectileProjectRoot(dir)
    if (!root || seen.has(root)) continue
    seen.add(root)
    out.push(root)
  }
  return out
}

function testFilePredicate(file: string): boolean {
  return /(?:^|\/)(?:test|spec|tests)\/|(?:_test|\.test|\.spec)\./.test(file)
}

function complementaryTestPath(file: string): string {
  if (/_test\.[^/]+$/.test(file)) return file.replace(/_test(\.[^/]+)$/, "$1")
  if (/\.test\.[^/]+$/.test(file)) return file.replace(/\.test(\.[^/]+)$/, "$1")
  if (/\/test\//.test(file)) return file.replace(/\/test\//, "/")
  const base = basename(file)
  const dir = dirname(file)
  const stem = base.replace(/\.[^.]+$/, "")
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")) : ""
  return join(dir, `${stem}_test${ext}`)
}

const PROJECTILE_COMMAND_MAP: Array<[string, string]> = [
  ["4 a", "projectile-find-other-file-other-window"],
  ["4 b", "projectile-switch-to-buffer-other-window"],
  ["4 f", "projectile-find-file-other-window"],
  ["4 g", "projectile-find-file-dwim-other-window"],
  ["4 t", "projectile-find-implementation-or-test-other-window"],
  ["5 f", "projectile-find-file-other-frame"],
  ["5 g", "projectile-find-file-dwim-other-frame"],
  ["!", "projectile-run-shell-command-in-root"],
  ["?", "projectile-find-references"],
  ["a", "projectile-find-other-file"],
  ["A", "projectile-add-known-project"],
  ["b", "projectile-switch-to-buffer"],
  ["d", "projectile-find-dir"],
  ["D", "projectile-dired"],
  ["e", "projectile-recentf"],
  ["g", "projectile-find-file-dwim"],
  ["F", "projectile-find-file-in-known-projects"],
  ["f", "projectile-find-file"],
  ["i", "projectile-invalidate-cache"],
  ["k", "projectile-kill-buffers"],
  ["p", "projectile-switch-project"],
  ["q", "projectile-switch-open-project"],
  ["r", "projectile-replace"],
  ["s g", "projectile-grep"],
  ["s s", "projectile-ag"],
  ["t", "projectile-toggle-between-implementation-and-test"],
  ["T", "projectile-find-test-file"],
  ["v", "projectile-vc"],
  ["z", "projectile-cache-current-file"],
  ["c c", "projectile-compile-project"],
  ["c t", "projectile-test-project"],
  ["c r", "projectile-run-project"],
]

async function loadDeps(): Promise<ProjectileDeps> {
  const home = jemacsHome()
  const [hooks, keymap, minor, runtime, custom, compile] = await Promise.all([
    import(join(home, "src/kernel/hooks.ts")),
    import(join(home, "src/kernel/keymap.ts")),
    import(join(home, "src/modes/minor-mode.ts")),
    import(join(home, "src/platform/runtime.ts")),
    import(join(home, "src/runtime/custom.ts")),
    import(join(home, "plugins/compile/index.ts")),
  ])
  return {
    addHook: hooks.addHook,
    Keymap: keymap.Keymap,
    defineMinorMode: minor.defineMinorMode,
    spawnProcess: runtime.spawnProcess,
    defcustom: custom.defcustom,
    getCustom: custom.getCustom,
    compilationStart: compile.compilationStart,
    lastCompileCommand: compile.lastCompileCommand,
  }
}

export async function install(editor: Editor): Promise<void> {
  const deps = await loadDeps()
  const { addHook, Keymap, defineMinorMode, defcustom, getCustom, compilationStart, lastCompileCommand, spawnProcess } = deps

  defcustom("projectile-enable-caching", "boolean", true,
    "When t enables project files caching for the session.")
  defcustom("projectile-keymap-prefix", "string", "C-c p",
    "Projectile keymap prefix (Stephen: C-c p).")
  defcustom("projectile-known-projects-file", "string", join(jemacsDir(), "projectile-bookmarks.json"),
    "File where Projectile known project roots are persisted.")
  defcustom("projectile-switch-project-action", "string", "projectile-find-file",
    "Command invoked after switching projects.")
  defcustom("projectile-require-project-root", "sexp", false,
    "nil, t, or prompt — whether a project root is required.")
  defcustom("projectile-ignored-projects", "sexp", [],
    "Projects not added to projectile-known-projects.")
  defcustom("projectile-track-known-projects-automatically", "boolean", true,
    "Register projects when visiting files.")

  const projectileMap = new Keymap("projectile-command-map")
  const defaultOpen: FindFileOp = async (ed, path) => { await ed.openFile(path) }
  const otherWindowOpen: FindFileOp = async (ed, path) => { await ed.run("find-file-other-window", [path]) }

  editor.command("projectile-project-root", async ({ editor, args }) => {
    const root = await projectileProjectRoot(args[0] ?? await startDir(editor))
    if (root) editor.message(root)
    return root
  }, "Echo the root directory of the current project.")

  editor.command("projectile-find-file", async ({ editor, args, prefixArgument }) => {
    await openFindFile(editor, deps, prefixArgument, defaultOpen, args[0])
  }, "Jump to a project's file using completion.")

  editor.command("projectile-find-file-other-window", async ({ editor, args, prefixArgument }) => {
    await openFindFile(editor, deps, prefixArgument, otherWindowOpen, args[0])
  }, "Jump to a project file in another window.")

  editor.command("projectile-find-file-other-frame", async ({ editor, args, prefixArgument }) => {
    await openFindFile(editor, deps, prefixArgument, defaultOpen, args[0])
  }, "Jump to a project file (no separate frame in Jemacs).")

  editor.command("projectile-find-file-dwim", async ({ editor, args, prefixArgument }) => {
    await findFileDwim(editor, deps, prefixArgument, defaultOpen, args[0])
  }, "Jump to a project file using completion based on context.")

  editor.command("projectile-find-file-dwim-other-window", async ({ editor, args, prefixArgument }) => {
    await findFileDwim(editor, deps, prefixArgument, otherWindowOpen, args[0])
  }, "DWIM find-file in another window.")

  editor.command("projectile-switch-project", async ({ editor, prefixArgument }) => {
    const projects = await projectileKnownProjects(getCustom)
    if (!projects.length) {
      editor.message("There are no known projects")
      return
    }
    const root = await projectileCompletingRead(editor, "Switch to project: ", projects, null, getCustom, "projectile-project")
    if (!root) return
    await switchProjectByName(editor, root, prefixArgument != null, getCustom)
  }, "Switch to a known project.")

  editor.command("projectile-switch-open-project", async ({ editor, prefixArgument }) => {
    const projects = await openProjects(editor)
    if (!projects.length) {
      editor.message("There are no open projects")
      return
    }
    const root = await projectileCompletingRead(editor, "Switch to open project: ", projects, null, getCustom, "projectile-project")
    if (!root) return
    await switchProjectByName(editor, root, prefixArgument != null, getCustom)
  }, "Switch to an open project.")

  editor.command("projectile-invalidate-cache", async ({ editor, prefixArgument }) => {
    invalidateProjectCaches()
    if (prefixArgument != null) {
      const roots = [...projectsCache.keys()]
      const root = await editor.completingRead("Remove cache for: ", { collection: roots })
      if (root) invalidateProjectCaches(String(root))
    } else {
      const root = await projectileProjectRoot(await startDir(editor))
      if (root) invalidateProjectCaches(root)
    }
    editor.message("Invalidated Projectile cache.")
  }, "Remove the current project's files from cache.")

  editor.command("projectile-dired", async ({ editor, prefixArgument }) => {
    let root: string | null
    if (prefixArgument != null) {
      const projects = await projectileKnownProjects(getCustom)
      root = await projectileCompletingRead(editor, "Dired in project: ", projects, null, getCustom, "projectile-project")
    } else {
      root = await acquireRoot(editor, getCustom)
    }
    if (!root) return
    await editor.run("dired", [root])
  }, "Open dired at the project root.")

  editor.command("projectile-compile-project", async ({ editor, args, prefixArgument }) => {
    const root = await acquireRoot(editor, getCustom)
    if (!root) return
    const cmd = args[0]
      ?? (prefixArgument != null
        ? await editor.prompt("Compile command: ", lastCompileCommand(editor), "compile-command")
        : lastCompileCommand(editor))
    if (!cmd) return
    await compilationStart(editor, cmd, root)
  }, "Compile the current project.")

  editor.command("projectile-grep", async ({ editor, args }) => {
    const root = await acquireRoot(editor, getCustom)
    if (!root) return
    const pattern = args[0] ?? await editor.prompt(prependProjectName("Grep for: ", root, getCustom), "", "search")
    if (!pattern) return
    await editor.run("counsel-ag", [pattern])
  }, "Grep the project.")

  editor.command("projectile-ag", async ({ editor, args, prefixArgument }) => {
    const root = await acquireRoot(editor, getCustom)
    if (!root) return
    const label = prefixArgument != null ? "Ag regexp search for: " : "Ag search for: "
    const pattern = args[0] ?? await editor.prompt(prependProjectName(label, root, getCustom), "", "search")
    if (!pattern) return
    await editor.run("counsel-ag", [pattern])
  }, "Search the project with ripgrep.")

  editor.command("projectile-recentf", async ({ editor }) => {
    await editor.run("recentf-open")
  }, "Open a recent file.")

  editor.command("projectile-add-known-project", async ({ editor, args }) => {
    const root = args[0] ?? await editor.prompt("Add to known projects: ", editor.currentBuffer.directory() ?? process.cwd())
    if (!root) return
    await projectileAddKnownProject(root, getCustom)
    editor.message(`Added ${resolve(root)} to known projects`)
  }, "Add a directory to known projects.")

  editor.command("projectile-switch-to-buffer", async ({ editor }) => {
    const root = await acquireRoot(editor, getCustom)
    if (!root) return
    const names = projectBufferFiles(editor, root).map(b => b.name)
    const choice = await projectileCompletingRead(editor, "Switch to buffer: ", names, root, getCustom, "projectile-buffer")
    if (!choice) return
    editor.switchToBuffer(choice)
  }, "Switch to a buffer in the current project.")

  editor.command("projectile-switch-to-buffer-other-window", async ({ editor }) => {
    const root = await acquireRoot(editor, getCustom)
    if (!root) return
    const names = projectBufferFiles(editor, root).map(b => b.name)
    const choice = await projectileCompletingRead(editor, "Switch to buffer: ", names, root, getCustom, "projectile-buffer")
    if (!choice) return
    await editor.run("switch-to-buffer-other-window", [choice])
  }, "Switch to a project buffer in another window.")

  editor.command("projectile-kill-buffers", async ({ editor }) => {
    const root = await acquireRoot(editor, getCustom)
    if (!root) return
    const buffers = projectBufferFiles(editor, root).filter(b => b.path)
    for (const buf of buffers) editor.killBuffer(buf.name)
    editor.message(`Killed ${buffers.length} project buffers`)
  }, "Kill project file buffers.")

  editor.command("projectile-find-dir", async ({ editor, prefixArgument }) => {
    const root = await acquireRoot(editor, getCustom)
    if (!root) return
    maybeInvalidateCache(prefixArgument, root)
    const files = await projectileProjectFiles(root, spawnProcess, getCustom)
    const dirs = [...new Set(files.map(f => {
      const d = dirname(f)
      return d === "." ? "" : d + "/"
    }).filter(Boolean))].sort()
    const choice = await projectileCompletingRead(editor, "Find directory: ", dirs, root, getCustom, "projectile-dir")
    if (!choice) return
    await editor.run("dired", [join(root, choice)])
  }, "Jump to a project directory.")

  editor.command("projectile-find-test-file", async ({ editor, prefixArgument }) => {
    const root = await acquireRoot(editor, getCustom)
    if (!root) return
    maybeInvalidateCache(prefixArgument, root)
    const files = (await projectileProjectFiles(root, spawnProcess, getCustom)).filter(testFilePredicate)
    const choice = await projectileCompletingRead(editor, "Find test file: ", files, root, getCustom, "projectile-file")
    if (!choice) return
    await editor.openFile(join(root, choice))
  }, "Jump to a test file in the project.")

  editor.command("projectile-toggle-between-implementation-and-test", async ({ editor }) => {
    const path = editor.currentBuffer.path
    const root = path ? await projectileProjectRoot(dirname(path)) : null
    if (!path || !root) {
      editor.message("Not in a project file")
      return
    }
    const rel = path.startsWith(root) ? path.slice(root.length + 1) : basename(path)
    const files = await projectileProjectFiles(root, spawnProcess, getCustom)
    const target = testFilePredicate(rel)
      ? files.find(f => f === rel.replace(/_test(\.[^/]+)$/, "$1").replace(/\.test(\.[^/]+)$/, "$1").replace(/\/test\//, "/"))
      : files.find(f => f === complementaryTestPath(rel))
    if (!target) {
      editor.message("No matching implementation/test file found")
      return
    }
    await editor.openFile(join(root, target))
  }, "Toggle between implementation and test file.")

  editor.command("projectile-find-other-file", async ({ editor }) => {
    editor.message("projectile-find-other-file: not yet implemented")
  }, "Switch between files with the same basename and different extensions.")

  editor.command("projectile-find-other-file-other-window", async ({ editor }) => {
    await editor.run("projectile-find-other-file")
  })

  editor.command("projectile-find-implementation-or-test-other-window", async ({ editor }) => {
    await editor.run("projectile-toggle-between-implementation-and-test")
  })

  editor.command("projectile-find-file-in-known-projects", async ({ editor }) => {
    const projects = await projectileKnownProjects(getCustom)
    const all: string[] = []
    for (const p of projects) {
      const files = await projectileProjectFiles(p, spawnProcess, getCustom)
      for (const f of files) all.push(join(p, f))
    }
    const choice = await editor.completingRead("Find file: ", { collection: all, history: "projectile-file" })
    if (choice) await editor.openFile(choice)
  }, "Find a file across all known projects.")

  editor.command("projectile-cache-current-file", async ({ editor }) => {
    const path = editor.currentBuffer.path
    const root = path ? await projectileProjectRoot(dirname(path)) : null
    if (!path || !root || !getCustom<boolean>("projectile-enable-caching")) return
    const rel = path.startsWith(root) ? path.slice(root.length + 1) : null
    if (!rel) return
    const cached = projectsCache.get(root) ?? []
    if (!cached.includes(rel)) {
      projectsCache.set(root, [rel, ...cached])
      editor.message(`File ${rel} added to project cache`)
    }
  }, "Add the current file to the project cache.")

  editor.command("projectile-replace", async ({ editor }) => {
    await editor.run("query-replace")
  }, "Replace in the current buffer.")

  editor.command("projectile-find-references", async ({ editor }) => {
    await editor.run("xref-find-references")
  }, "Find references in the project.")

  editor.command("projectile-vc", async ({ editor }) => {
    const root = await acquireRoot(editor, getCustom)
    if (!root) return
    await editor.run("dired", [root])
  }, "Open version control at project root.")

  editor.command("projectile-run-shell-command-in-root", async ({ editor, args }) => {
    const root = await acquireRoot(editor, getCustom)
    if (!root) return
    const cmd = args[0] ?? await editor.prompt(prependProjectName("Run command: ", root, getCustom), "", "shell-command")
    if (!cmd) return
    await compilationStart(editor, cmd, root)
  }, "Run a shell command at the project root.")

  editor.command("projectile-test-project", async ({ editor, args, prefixArgument }) => {
    const root = await acquireRoot(editor, getCustom)
    if (!root) return
    const cmd = args[0] ?? (prefixArgument != null ? await editor.prompt("Test command: ", "bun test", "compile-command") : "bun test")
    await compilationStart(editor, cmd, root)
  }, "Run the project test command.")

  editor.command("projectile-run-project", async ({ editor, args, prefixArgument }) => {
    const root = await acquireRoot(editor, getCustom)
    if (!root) return
    const cmd = args[0] ?? await editor.prompt("Run command: ", "", "compile-command")
    if (!cmd) return
    await compilationStart(editor, cmd, root)
  }, "Run the project.")

  editor.command("projectile-commander", async ({ editor }) => {
    await editor.run("execute-extended-command")
  }, "Projectile commander (M-x fallback).")

  const prefix = keymapPrefix(getCustom)
  for (const [suffix, command] of PROJECTILE_COMMAND_MAP) {
    projectileMap.bind(`${prefix} ${suffix}`, command)
  }

  defineMinorMode({
    name: "projectile-mode",
    lighter: " Projectile",
    global: true,
    keymap: projectileMap,
  })

  addHook("find-file-hook", async ({ editor, buffer }) => {
    if (!editor.isMinorModeEnabled("projectile-mode")) return
    const path = buffer.path
    if (!path) return
    const root = await projectileProjectRoot(dirname(path))
    if (!root) return
    if (getCustom<boolean>("projectile-track-known-projects-automatically")) {
      await projectileAddKnownProject(root, getCustom)
    }
    if (getCustom<boolean>("projectile-enable-caching") && projectsCache.has(root)) {
      const rel = path.startsWith(root) ? path.slice(root.length + 1) : null
      if (rel && !projectsCache.get(root)!.includes(rel)) {
        projectsCache.set(root, [rel, ...projectsCache.get(root)!])
      }
    }
  })

  editor.enableMinorMode("projectile-mode")
}
