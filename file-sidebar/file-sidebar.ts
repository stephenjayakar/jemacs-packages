import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import {
  buildFileTree,
  defaultExpandedPaths,
  renderFileTree,
  sidebarFontLock,
  sidebarLineAtPoint,
  type FileTreeNode,
  type SidebarLine,
} from "./tree"
import { projectileProjectFiles, projectileProjectRoot } from "../projectile/projectile"

type Editor = import("../../jemacs-opentui/src/kernel/editor").Editor
type BufferModel = import("../../jemacs-opentui/src/kernel/buffer").BufferModel

type FileSidebarDeps = {
  addHook: typeof import("../../jemacs-opentui/src/kernel/hooks").addHook
  Keymap: typeof import("../../jemacs-opentui/src/kernel/keymap").Keymap
  defineMode: typeof import("../../jemacs-opentui/src/modes/mode").defineMode
  defineMinorMode: typeof import("../../jemacs-opentui/src/modes/minor-mode").defineMinorMode
  findWindowLeaf: typeof import("../../jemacs-opentui/src/kernel/window").findWindowLeaf
  listWindowLeaves: typeof import("../../jemacs-opentui/src/kernel/window").listWindowLeaves
  defcustom: typeof import("../../jemacs-opentui/src/runtime/custom").defcustom
  getCustom: typeof import("../../jemacs-opentui/src/runtime/custom").getCustom
  spawnProcess: typeof import("../../jemacs-opentui/src/platform/runtime").spawnProcess
  projectRoot: typeof import("../../jemacs-opentui/plugins/project/index").projectRoot
  projectFiles: typeof import("../../jemacs-opentui/plugins/project/index").projectFiles
}

const SIDEBAR_BUFFER = "*File Sidebar*"
const SIDEBAR_TREE = "file-sidebar-tree"
const SIDEBAR_LINES = "file-sidebar-lines"
const SIDEBAR_TREE_ROOT = "file-sidebar-tree-root"
const SIDEBAR_PROJECT = "file-sidebar-project-root"
const SIDEBAR_EXPANDED = "file-sidebar-expanded"
const SIDEBAR_HIGHLIGHT = "file-sidebar-highlight"

type EditorState = {
  sidebarWindowId: string | null
  mainWindowId: string | null
}

const editorState = new WeakMap<Editor, EditorState>()
const installedEditors = new WeakSet<Editor>()

function jemacsHome(): string {
  return process.env.JEMACS_HOME ?? join(homedir(), "programming", "jemacs", "jemacs-opentui")
}

async function loadDeps(): Promise<FileSidebarDeps> {
  const home = jemacsHome()
  const [hooks, keymap, mode, minor, window, custom, runtime, project] = await Promise.all([
    import(join(home, "src/kernel/hooks.ts")),
    import(join(home, "src/kernel/keymap.ts")),
    import(join(home, "src/modes/mode.ts")),
    import(join(home, "src/modes/minor-mode.ts")),
    import(join(home, "src/kernel/window.ts")),
    import(join(home, "src/runtime/custom.ts")),
    import(join(home, "src/platform/runtime.ts")),
    import(join(home, "plugins/project/index.ts")),
  ])
  return {
    addHook: hooks.addHook,
    Keymap: keymap.Keymap,
    defineMode: mode.defineMode,
    defineMinorMode: minor.defineMinorMode,
    findWindowLeaf: window.findWindowLeaf,
    listWindowLeaves: window.listWindowLeaves,
    defcustom: custom.defcustom,
    getCustom: custom.getCustom,
    spawnProcess: runtime.spawnProcess,
    projectRoot: project.projectRoot,
    projectFiles: project.projectFiles,
  }
}

function st(editor: Editor): EditorState {
  let s = editorState.get(editor)
  if (!s) {
    s = { sidebarWindowId: null, mainWindowId: null }
    editorState.set(editor, s)
  }
  return s
}

function sidebarWidthRatio(getCustom: FileSidebarDeps["getCustom"]): number {
  const width = getCustom<number>("file-sidebar-width") ?? 28
  return Math.max(0.12, Math.min(0.45, width / 100))
}

async function resolveProject(editor: Editor, deps: FileSidebarDeps): Promise<{ root: string; files: string[] } | null> {
  const start = editor.currentBuffer.directory() ?? process.cwd()
  const root = await projectileProjectRoot(start) ?? await deps.projectRoot(start)
  if (!root) return null
  const files = await projectileProjectFiles(root, deps.spawnProcess, deps.getCustom)
    .catch(async () => deps.projectFiles(root))
  return { root, files }
}

function sidebarBuffer(editor: Editor): BufferModel | undefined {
  return [...editor.buffers.values()].find(b => b.name === SIDEBAR_BUFFER)
}

function findSidebarWindow(editor: Editor, listWindowLeaves: FileSidebarDeps["listWindowLeaves"]): string | null {
  const buffer = sidebarBuffer(editor)
  if (!buffer) return null
  for (const leaf of listWindowLeaves(editor.windowLayout)) {
    if (leaf.bufferId === buffer.id && leaf.dedicated) return leaf.id
  }
  return null
}

function sidebarLines(buffer: BufferModel): SidebarLine[] {
  return (buffer.locals.get(SIDEBAR_LINES) as SidebarLine[] | undefined) ?? []
}

function sidebarExpanded(buffer: BufferModel): Set<string> {
  let expanded = buffer.locals.get(SIDEBAR_EXPANDED) as Set<string> | undefined
  if (!expanded) {
    const tree = buffer.locals.get(SIDEBAR_TREE_ROOT) as FileTreeNode | undefined
    expanded = tree ? defaultExpandedPaths(tree, buffer.locals.get(SIDEBAR_HIGHLIGHT) as string | undefined) : new Set()
    buffer.locals.set(SIDEBAR_EXPANDED, expanded)
  }
  return expanded
}

function paintSidebarBuffer(buffer: BufferModel): void {
  const tree = buffer.locals.get(SIDEBAR_TREE_ROOT) as FileTreeNode | undefined
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  if (!tree) {
    buffer.setText("(no project)\n", false)
    buffer.locals.delete(SIDEBAR_LINES)
    buffer.point = 0
    buffer.readOnly = wasReadOnly
    return
  }
  const projectRootPath = buffer.locals.get(SIDEBAR_PROJECT) as string | undefined
  const highlightRel = buffer.locals.get(SIDEBAR_HIGHLIGHT) as string | undefined
  const rendered = renderFileTree(tree, sidebarExpanded(buffer), {
    projectLabel: projectRootPath ? basename(projectRootPath) || projectRootPath : undefined,
    highlightRel,
  })
  buffer.setText(rendered.text, false)
  buffer.locals.set(SIDEBAR_LINES, rendered.lines)
  buffer.point = Math.min(buffer.point, Math.max(0, buffer.text.length - 1))
  buffer.readOnly = wasReadOnly
}

async function refreshSidebar(editor: Editor, deps: FileSidebarDeps, buffer = sidebarBuffer(editor)): Promise<void> {
  if (!buffer) return
  const previousHighlight = buffer.locals.get(SIDEBAR_HIGHLIGHT) as string | undefined
  const previousExpanded = buffer.locals.get(SIDEBAR_EXPANDED) as Set<string> | undefined
  const project = await resolveProject(editor, deps)
  if (!project) {
    const wasReadOnly = buffer.readOnly
    buffer.readOnly = false
    buffer.setText("No project root found.\n\nUse projectile or open a file inside a git repo.\n", false)
    buffer.readOnly = wasReadOnly
    buffer.locals.delete(SIDEBAR_TREE_ROOT)
    buffer.locals.delete(SIDEBAR_LINES)
    buffer.locals.delete(SIDEBAR_PROJECT)
    buffer.point = 0
    void editor.changed("file-sidebar-refresh")
    return
  }
  buffer.locals.set(SIDEBAR_PROJECT, project.root)
  const tree = buildFileTree(project.files)
  buffer.locals.set(SIDEBAR_TREE_ROOT, tree)
  const expanded = previousExpanded ?? defaultExpandedPaths(tree, previousHighlight)
  buffer.locals.set(SIDEBAR_EXPANDED, expanded)
  paintSidebarBuffer(buffer)
  void editor.changed("file-sidebar-refresh")
}

function relPathForAbsolute(projectRootPath: string, absolute?: string): string | undefined {
  if (!absolute) return undefined
  const full = resolve(absolute)
  const root = resolve(projectRootPath)
  if (full === root) return ""
  if (!full.startsWith(root + "/")) return undefined
  return full.slice(root.length + 1)
}

function syncSidebarHighlight(editor: Editor, buffer = sidebarBuffer(editor)): void {
  if (!buffer) return
  const projectRootPath = buffer.locals.get(SIDEBAR_PROJECT) as string | undefined
  if (!projectRootPath) return
  const rel = relPathForAbsolute(projectRootPath, editor.currentBuffer.path)
  if (rel === buffer.locals.get(SIDEBAR_HIGHLIGHT)) return
  if (rel) buffer.locals.set(SIDEBAR_HIGHLIGHT, rel)
  else buffer.locals.delete(SIDEBAR_HIGHLIGHT)
  const tree = buffer.locals.get(SIDEBAR_TREE_ROOT) as FileTreeNode | undefined
  if (tree && rel) {
    const expanded = sidebarExpanded(buffer)
    for (let i = 1; i < rel.split("/").length; i++) {
      expanded.add(rel.split("/").slice(0, i).join("/"))
    }
    buffer.locals.set(SIDEBAR_EXPANDED, expanded)
  }
  paintSidebarBuffer(buffer)
}

async function showSidebar(editor: Editor, deps: FileSidebarDeps): Promise<void> {
  const existing = findSidebarWindow(editor, deps.listWindowLeaves)
  if (existing) {
    st(editor).sidebarWindowId = existing
    const buf = sidebarBuffer(editor)
    if (buf) {
      editor.selectWindow(existing)
      await refreshSidebar(editor, deps, buf)
      syncSidebarHighlight(editor, buf)
    }
    return
  }

  const mainWindowId = editor.selectedWindowId
  editor.splitWindowRight()
  const sidebarWindowId = mainWindowId
  const mainAfterSplit = editor.selectedWindowId

  editor.selectWindow(sidebarWindowId)
  let buffer = sidebarBuffer(editor)
  if (!buffer) {
    buffer = editor.scratch(SIDEBAR_BUFFER, "", SIDEBAR_TREE)
  } else {
    editor.switchToBuffer(buffer.id)
    editor.enterMode(buffer, SIDEBAR_TREE)
  }
  buffer.readOnly = true
  editor.setSelectedWindowDedicated(true)
  if (typeof editor.setWindowSplitRatio === "function") {
    editor.setWindowSplitRatio(sidebarWindowId, sidebarWidthRatio(deps.getCustom))
  }

  st(editor).sidebarWindowId = sidebarWindowId
  st(editor).mainWindowId = mainAfterSplit
  editor.selectWindow(mainAfterSplit)

  await refreshSidebar(editor, deps, buffer)
  syncSidebarHighlight(editor, buffer)
}

function hideSidebar(editor: Editor, deps: FileSidebarDeps): void {
  const sidebarWindowId = findSidebarWindow(editor, deps.listWindowLeaves) ?? st(editor).sidebarWindowId
  if (!sidebarWindowId) return
  const mainWindowId = st(editor).mainWindowId
  if (mainWindowId && deps.findWindowLeaf(editor.windowLayout, mainWindowId)) {
    editor.selectWindow(mainWindowId)
  } else {
    const other = deps.listWindowLeaves(editor.windowLayout).find(leaf => leaf.id !== sidebarWindowId)
    if (other) editor.selectWindow(other.id)
  }
  if (deps.listWindowLeaves(editor.windowLayout).length > 1) {
    editor.selectWindow(sidebarWindowId)
    editor.deleteWindow()
  }
  st(editor).sidebarWindowId = null
  st(editor).mainWindowId = null
}

function lineAtPoint(buffer: BufferModel): SidebarLine | undefined {
  return sidebarLineAtPoint(sidebarLines(buffer), buffer.point)
}

function toggleNodeAtPoint(editor: Editor, buffer: BufferModel): void {
  const line = lineAtPoint(buffer)
  if (!line?.isDirectory) return
  const expanded = sidebarExpanded(buffer)
  if (expanded.has(line.relPath)) expanded.delete(line.relPath)
  else expanded.add(line.relPath)
  paintSidebarBuffer(buffer)
  void editor.changed("file-sidebar-toggle")
}

async function openAtPoint(editor: Editor, deps: FileSidebarDeps, buffer: BufferModel): Promise<void> {
  const line = lineAtPoint(buffer)
  if (!line) return
  if (line.isDirectory) {
    toggleNodeAtPoint(editor, buffer)
    return
  }
  const projectRootPath = buffer.locals.get(SIDEBAR_PROJECT) as string | undefined
  if (!projectRootPath) return
  const path = join(projectRootPath, line.relPath)
  const mainWindowId = st(editor).mainWindowId
  if (mainWindowId && deps.findWindowLeaf(editor.windowLayout, mainWindowId)) {
    editor.selectWindow(mainWindowId)
  }
  await editor.openFile(path)
  syncSidebarHighlight(editor, buffer)
}

function installSidebarMode(deps: FileSidebarDeps): void {
  const keymap = new deps.Keymap("file-sidebar-tree-map")
  keymap.bind("return", "file-sidebar-open")
  keymap.bind("enter", "file-sidebar-open")
  keymap.bind("RET", "file-sidebar-open")
  keymap.bind("tab", "file-sidebar-toggle")
  keymap.bind("C-i", "file-sidebar-toggle")
  keymap.bind("SPC", "file-sidebar-toggle")
  keymap.bind("g", "file-sidebar-refresh")
  keymap.bind("q", "file-sidebar-hide")
  keymap.bind("n", "next-line")
  keymap.bind("p", "previous-line")
  keymap.bind("C-n", "next-line")
  keymap.bind("C-p", "previous-line")
  deps.defineMode({
    name: SIDEBAR_TREE,
    parent: "text",
    keymap,
    fontLock: buffer => sidebarFontLock(
      buffer.text,
      sidebarLines(buffer),
      {
        highlightRel: buffer.locals.get(SIDEBAR_HIGHLIGHT) as string | undefined,
        point: buffer.point,
      },
    ),
  })
}

export async function install(editor: Editor): Promise<void> {
  const deps = await loadDeps()
  installSidebarMode(deps)

  deps.defcustom("file-sidebar-width", "number", 28,
    "Sidebar width as a percentage of the frame (12–45).")

  deps.defineMinorMode({
    name: "file-sidebar-mode",
    lighter: " Sidebar",
    global: true,
    onEnable: ed => {
      void showSidebar(ed, deps)
    },
    onDisable: ed => {
      hideSidebar(ed, deps)
    },
  })

  if (installedEditors.has(editor)) return
  installedEditors.add(editor)

  editor.command("file-sidebar-mode", ({ editor, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument > 0) editor.enableMinorMode("file-sidebar-mode")
    else if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("file-sidebar-mode")
    else editor.toggleMinorMode("file-sidebar-mode")
  }, "Toggle the projectile file sidebar.")

  editor.command("file-sidebar-show", async ({ editor }) => {
    if (!editor.isMinorModeEnabled("file-sidebar-mode")) editor.enableMinorMode("file-sidebar-mode")
    else await showSidebar(editor, deps)
  }, "Show the projectile file sidebar.")

  editor.command("file-sidebar-hide", ({ editor }) => {
    if (editor.isMinorModeEnabled("file-sidebar-mode")) editor.disableMinorMode("file-sidebar-mode")
    else hideSidebar(editor, deps)
  }, "Hide the projectile file sidebar.")

  editor.command("file-sidebar-refresh", async ({ editor, buffer }) => {
    if (buffer.mode === SIDEBAR_TREE) await refreshSidebar(editor, deps, buffer)
    else await refreshSidebar(editor, deps)
  }, "Refresh the file sidebar tree from projectile.")

  editor.command("file-sidebar-toggle", ({ editor, buffer }) => {
    if (buffer.mode !== SIDEBAR_TREE) return
    toggleNodeAtPoint(editor, buffer)
  }, "Expand or collapse the directory at point in the file sidebar.")

  editor.command("file-sidebar-open", async ({ editor, buffer }) => {
    if (buffer.mode !== SIDEBAR_TREE) return
    await openAtPoint(editor, deps, buffer)
  }, "Open the file at point, or toggle a directory, in the file sidebar.")

  editor.command("file-sidebar-focus-main", ({ editor }) => {
    const mainWindowId = st(editor).mainWindowId
    if (mainWindowId && deps.findWindowLeaf(editor.windowLayout, mainWindowId)) {
      editor.selectWindow(mainWindowId)
      return
    }
    const sidebarWindowId = findSidebarWindow(editor, deps.listWindowLeaves)
    const other = deps.listWindowLeaves(editor.windowLayout).find(leaf => leaf.id !== sidebarWindowId)
    if (other) editor.selectWindow(other.id)
  }, "Move focus from the file sidebar to the main editing window.")

  editor.key("C-c C-b", "file-sidebar-mode")

  deps.addHook("find-file-hook", async ({ editor }) => {
    if (!editor.isMinorModeEnabled("file-sidebar-mode")) return
    const buffer = sidebarBuffer(editor)
    if (!buffer) return
    syncSidebarHighlight(editor, buffer)
  })
}

export {
  buildFileTree,
  defaultExpandedPaths,
  renderFileTree,
  sidebarFontLock,
  sidebarLineAtPoint,
} from "./tree"
