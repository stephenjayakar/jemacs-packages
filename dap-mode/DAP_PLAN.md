# DAP mode parity plan

## Audit scope

This plan compares the Jemacs package in this directory with the exact GNU
Emacs package currently installed at:

```text
~/.emacs.d/elpa/dap-mode-20260616.1526/
```

Stephen's active GNU configuration is narrower than the complete upstream
package: it requires `dap-python`, selects `debugpy`, installs stale-breakpoint
pruning before `dap-debug`, and enables `dap-auto-configure-mode`. Therefore,
parity has two completion levels:

1. **Daily-driver parity**: Stephen's configured Python/debugpy workflow looks
   and behaves like GNU Emacs, including failure cases and multiple sessions.
2. **Full installed-package parity**: the public commands, customization,
   hooks, UI features, protocol behavior, and adapter modules shipped by the
   installed GNU package are available with matching semantics.

The current implementation passes focused unit tests, the full package suite,
and a real debugpy breakpoint/step/continue smoke test against
`/Users/stephen/programming/vibe/temp/main.py`, but it has not reached either
completion level.

## Remaining parity at a glance

The largest gaps are not basic DAP transport anymore. They are GNU-compatible
editing and UI semantics: a full `*DAP Templates*` workflow, complete
breakpoint-pane behavior across all visiting buffers, tooltip/mouse behavior,
pane focus and teardown fidelity, multiline REPL/evaluation presentation,
terminal routing, Python/LSP/pyenv template fidelity, stale-response and
request-cancellation handling, and cross-editor verification against GNU
Emacs. The complete upstream package also contains many adapter-specific
modules that are not yet ported.

The first implementation tranche below is now landed and verified: current
session/thread targeting, compound-session isolation, GNU-style relaunch,
edit-aware breakpoint anchors, GNU breakpoint-store writes, stack-trace
limits, lifecycle hook dispatch, output buffers, and the missing public command
entry points are implemented. The unchecked items remain real parity work, not
just documentation TODOs.

## What already works

- DAP Content-Length transport over stdio and TCP.
- `initialize`, `launch`/`attach`, `configurationDone`, source breakpoints,
  one default exception filter, threads, stack frames, scopes, variables,
  evaluation, continue/pause/step, `restartFrame`, terminate, and disconnect.
- The `runInTerminal` reverse request through JTerm.
- Python/debugpy and Node/js-debug adapter startup.
- Five familiar Python configuration names, including pytest and attach.
- `.vscode/launch.json` JSONC parsing, compounds, inputs, variable expansion,
  presentation ordering, and extension APIs for providers/tasks.
- Importing Stephen's GNU `.dap-breakpoints` file and pruning missing or
  out-of-range breakpoints before a debug run.
- Breakpoint and execution-line gutter decorations.
- Breakpoints, Locals, Expressions, and Debug Sessions panes that approximate
  the GNU stop-time layout.
- A real debugpy integration test using
  `/Users/stephen/programming/vibe/temp/main.py`.

## P0 — Correct the existing daily-driver behavior

These are correctness gaps in commands that already exist. They should land
before adding more surface area.

### Current-session semantics

GNU commands operate on the current session and current thread. The original
Jemacs implementation used `eachActive`, so continue, pause, stepping,
restart, and disconnect were sent to every non-terminated session.

- [x] Add explicit `currentSession`, `currentThread`, and current-frame state.
- [x] Make `dap-continue`, `dap-pause`, `dap-next`, `dap-step-in`,
      `dap-step-out`, `dap-restart-frame`, and `dap-disconnect` target only the
      current session/thread.
- [x] Make `dap-switch-session` update current state and run the corresponding
      lifecycle hooks; do not implement selection by reordering an array.
- [x] Make `dap-switch-thread` and frame navigation preserve independent
      selections per session and thread.
- [x] Add prefix-argument behavior to `dap-up-stack-frame` and
      `dap-down-stack-frame`.
- [x] Implement `dap-stop-thread` when the adapter advertises support.
- [x] Test two simultaneous sessions and a compound configuration so an
      operation on one cannot accidentally resume or kill the other.

### Restart and session deletion

GNU `dap-debug-restart` disconnects/relaunches the current launch arguments and
honors `dap-debug-restart-keep-session`. Jemacs currently sends the protocol
`restart` request to every active adapter, which is different behavior.

- [x] Reimplement `dap-debug-restart` as GNU-style relaunch.
- [x] Add `dap-debug-restart-keep-session` and prefix-argument inversion.
- [x] Keep protocol-level `restart` as an internal capability, not the public
      behavior of `dap-debug-restart`.
- [x] Implement `dap-delete-session` and `dap-delete-all-sessions`, including
      terminated-session cleanup and output-buffer disposal.
- [x] Handle adapters that terminate during relaunch without leaking windows,
      processes, pending requests, or current-session state.

### Breakpoint fidelity

GNU stores buffer positions backed by moving markers. Jemacs imports positions
once, converts them to line numbers, and then persists a separate JSON file.
The two editors consequently drift, and breakpoints do not follow edits.

- [x] Represent breakpoints with edit-aware buffer markers/anchors rather than
      fixed line numbers.
- [x] Update anchors on every buffer splice and serialize the current point when
      a file buffer is saved or killed.
- [x] Read and write GNU-compatible `.dap-breakpoints` data, preserving
      condition, hit condition, and log message fields.
- [x] Define a conflict policy when both the GNU store and the Jemacs state file
      changed; do not silently duplicate breakpoints.
- [ ] Match GNU behavior for add, toggle, delete, condition, hit condition, log
      message, and delete-all in both source and Breakpoints panes.
- [ ] Run breakpoint-changed behavior for every affected visiting buffer.
- [x] Preserve verified/pending adapter responses without changing the user's
      requested source position incorrectly.
- [x] Make exception breakpoints configurable from adapter-provided filters
      instead of hard-coding only `uncaught`.
- [ ] Add tests that insert/delete lines above breakpoints, restart Jemacs, then
      open the same file in GNU Emacs and confirm identical positions.

### Python configuration fidelity

- [ ] Derive pytest-at-point targets from LSP document symbols like
      `dap-python`, rather than the current backwards regex scan.
- [ ] Verify all five Python templates against real debugpy:
      run file, pytest buffer, pytest at point, process attach, and project-cwd.
- [x] Implement the actual `dap-python-debugger` choice contract and explicitly
      reject unsupported `ptvsd` instead of exposing a misleading option.
- [x] Add `dap-python-terminal` and use it for generated Python configurations.
- [x] Add `dap-python-default-debug-port` and a direct debugpy port-attach
      command.
- [ ] Add pyenv-aware
      executable discovery, and GNU-compatible defaults.
- [ ] Test spaces, Unicode paths, virtual environments, pytest classes,
      parametrized tests, modules, process attach, and failed adapter startup.

## P1 — Make auto-configure and the UI functional, not just visual

### Modes and feature selection

`dap-ui-controls-mode` and `dap-tooltip-mode` currently only toggle names in
the global mode set. They do not implement their GNU behavior.

- [x] Add `dap-auto-configure-features` with GNU's default:
      sessions, locals, breakpoints, expressions, controls, and tooltip.
- [x] Make `dap-auto-configure-mode` enable/disable exactly the selected
      features and clean up their resources.
- [x] Implement real `dap-ui-controls-mode` controls with current-session
      buttons and current-session state.
- [ ] Hide controls whose adapter capability is unavailable.
- [x] Implement `dap-tooltip-at-point`, configurable delay, and
      echo-area/child-frame presentation.
- [ ] Make `dap-tooltip-mode` install/remove mouse tracking globally and add
      host-specific fallback behavior.
- [ ] Implement the global `dap-ui-mode` hooks rather than treating it only as
      a boolean flag.
- [x] Add the buffer-local `dap-ui-sessions-mode` and
      `dap-ui-breakpoints-mode` command/keymap behavior.

### Interactive tree panes

The panes currently render mostly static text. GNU panes are interactive,
refreshable trees with expandable variables, sessions, threads, frames,
sources, and breakpoints.

- [x] Add expandable nested variables with lazy `variables` requests.
- [x] Add `dap-ui-default-fetch-count` to lazy variable requests.
- [x] Add named/indexed paging.
- [x] Add `setVariable` and editable local values.
- [x] Implement `dap-ui-variable-length` truncation.
- [ ] Add an action to reveal full truncated values.
- [x] Make Sessions rows select/delete sessions, threads, and frames.
- [x] Implement Breakpoints pane commands:
      `dap-ui-breakpoints-goto`, `-delete`, `-browse`, `-delete-selected`, and
      `-list`.
- [x] Implement Expressions add-prompt, remove, refresh, duplicate detection,
      error rendering, and persistence.
- [x] Add expandable expression results.
- [x] Implement `dap-ui-loaded-sources`, including adapter `loadedSource`
      events and source-reference-only entries.
- [ ] Match GNU pane focus, dedicated-window, sizing, refresh, quit, and
      teardown behavior.
- [ ] Add customization for locals/sessions/expressions expansion depth and UI
      buffer placement.
- [ ] Compare GNU and Jemacs screen captures at initial stop, nested stop,
      continue, session switch, and termination.

### Controls, hydra, and mouse behavior

- [x] Replace the current one-line `dap-hydra` message with an interactive
      hydra/transient matching the GNU key groups and repeat/exit behavior.
- [ ] Add gutter/margin mouse breakpoint toggling.
- [ ] Add hover evaluation and clickable controls where supported by each host.
- [ ] Ensure TUI, Electron, and web hosts degrade consistently when mouse or
      child-frame support is unavailable.

## P1 — Output, REPL, and evaluation parity

### Output buffers

GNU dap-mode owns a per-session output buffer with category filtering,
automatic display rules, labels, height limits, and terminal routing. Jemacs
only accumulates output arrays and exposes a partial REPL.

- [x] Create one output buffer per session and implement
      `dap-go-to-output-buffer`.
- [x] Add runtime filtering/labels for `dap-print-io`,
      `dap-output-buffer-filter`, `dap-label-output-buffer-category`, and
      `dap-auto-show-output`.
- [ ] Apply `dap-output-window-min-height`,
      `dap-output-window-max-height`, and `dap-inhibit-io` with GNU-compatible
      window and message behavior.
- [x] Distinguish stdout, stderr, console, telemetry, important, and adapter
      output categories.
- [x] Preserve output for terminated sessions until the session is deleted.
- [ ] Route external/integrated/internal terminal kinds according to
      `dap-default-terminal-kind`, `dap-external-terminal`, and
      `dap-internal-terminal`.

### REPL and evaluation

- [x] Use GNU's `>> ` prompt, input history, per-session context, and history
      file behavior.
- [x] Implement adapter-backed `completions` and `dap-ui-repl-company` parity.
- [ ] Add multiline input and robust prompt-boundary editing.
- [x] Implement `dap-ui-eval-in-buffer` and `dap-ui-eval-variable-in-buffer`.
- [ ] Add expandable values to evaluation buffers.
- [ ] Match region/symbol evaluation errors, stopped-session selection, and
      overlay/echo presentation.
- [ ] Cancel or ignore stale evaluation/variable responses after continue,
      frame switch, or session termination.

## P1 — Lifecycle hooks and customization contract

The installed GNU core defines 26 custom variables and ten public lifecycle
hooks. Jemacs now defines the principal lifecycle hooks and a substantially
larger customization surface, but several variables still lack matching
runtime effects and reload semantics.

- [x] Implement and order these hooks consistently:
      `dap-session-created-hook`, `dap-session-changed-hook`,
      `dap-stopped-hook`, `dap-continue-hook`, `dap-executed-hook`,
      `dap-position-changed-hook`, `dap-stack-frame-changed-hook`,
      `dap-loaded-sources-changed-hook`, `dap-breakpoints-changed-hook`, and
      `dap-terminated-hook`.
- [ ] Pass the same conceptual session/frame data to hook handlers.
- [x] Add `dap-stack-trace-limit` and enforce it in `stackTrace` requests.
- [ ] Port the remaining core/UI/mouse/Python custom variables with matching
      types, defaults, and runtime effects; omit or rename only with a written
      incompatibility rationale.
- [ ] Ensure reload disposes hooks, adapters, processes, overlays, gutter
      sources, modes, keymaps, child frames, and pending timers exactly once.

## P2 — Templates, providers, tasks, and launch configuration

- [x] Implement `dap-register-debug-template` semantics and
      `dap-debug-template-configurations`.
- [ ] Implement `dap-debug-edit-template` and the `*DAP Templates*` workflow.
- [x] Store a real recent-configuration ring so `dap-debug-last` and
      `dap-debug-recent` match GNU behavior.
- [ ] Preserve launch arguments on sessions so restart/recent are lossless.
- [ ] Port `.vscode/launch.json` discovery and selection behavior from
      `dap-launch.el`, including multi-root workspaces.
- [x] Implement built-in `tasks.json` label/command/dependsOn discovery and
      execution; a custom provider can still override it.
- [ ] Match the remaining `dap-tasks.el` task kinds and problem matchers.
- [x] Supply a standard `${command:pickProcess}` resolver for process picking.
- [ ] Supply the remaining standard command resolvers.
- [ ] Validate input cancellation, password masking, command inputs, nested
      substitutions, compounds, `stopAll`, pre-launch tasks, and post-debug
      tasks with end-to-end tests.
- [ ] Support child sessions initiated by the adapter's `startDebugging`
      reverse request.

## P2 — Protocol and source fidelity

### Requests/events missing from the GNU feature set

- [x] `source` requests and virtual read-only buffers for `sourceReference`
      frames/breakpoints.
- [x] Remote-to-local/local-to-remote path transforms.
- [x] Add URI decoding for mapped source paths.
- [x] `exceptionInfo` at exception stops.
- [x] `setVariable` in the Locals tree.
- [x] `completions` in the REPL.
- [x] Loaded-source state and `loadedSource` events.
- [x] Correct current-session processing of process, module, invalidated,
      progress, and changed-capabilities events where adapters emit them.

### Robustness

- [ ] Honor `allThreadsStopped`, `allThreadsContinued`, stopped thread IDs,
      preserve-focus hints, and hit breakpoint IDs.
- [ ] Refresh only invalidated thread/frame/scope state and reject stale async
      responses by generation.
- [ ] Handle `terminated` restart metadata and adapters that exit before
      replying to disconnect.
- [ ] Implement request cancellation and distinguish timeout, adapter error,
      transport close, and user cancellation.
- [ ] Clarify the TCP readiness contract and test retry, delayed-listen,
      refused-connection, and adapter-exit races.
- [ ] Cover malformed framing, split UTF-8, unexpected responses, duplicate
      events, reverse-request errors, and adapter stderr floods.
- [ ] Add a protocol transcript test suite captured from debugpy and js-debug.

## P3 — Full public command parity

The following installed GNU interactive commands are missing or currently
non-equivalent and should have focused parity tests:

- [ ] `dap-debug-edit-template`
- [ ] `dap-go-to-output-buffer`
- [ ] `dap-delete-session` / `dap-delete-all-sessions`
- [ ] `dap-stop-thread`
- [ ] `dap-mode-mouse-set-clear-breakpoint`
- [ ] `dap-tooltip-at-point` / `dap-tooltip-mouse-motion`
- [ ] `dap-ui-breakpoints-goto`, `dap-ui-breakpoints-delete`,
      `dap-ui-breakpoints-browse`, `dap-ui-breakpoints-delete-selected`, and
      `dap-ui-breakpoints-list`
- [ ] `dap-ui-eval-in-buffer` / `dap-ui-eval-variable-in-buffer`
- [ ] `dap-ui-expressions-add-prompt`, `dap-ui-expressions-remove`, and
      `dap-ui-expressions-refresh`
- [ ] `dap-ui-loaded-sources`
- [ ] `dap-ui-repl-company`

Existing command names must also be tested for GNU-compatible interactive
arguments, current-session selection, errors, messages, and return behavior.
Jemacs-only convenience commands such as `dap-start-or-continue`, `dap-attach`,
and `dap-create-launch-json` may remain, but cannot substitute for GNU commands.

## P4 — Adapter-module parity

Only Python/debugpy and Node/js-debug startup are implemented. The installed
GNU package also ships dedicated modules for browser JavaScript, CodeLLDB,
cpptools, GDB/LLDB, Go/Delve, Docker, Elixir, Erlang, GDScript, Julia, Kotlin,
.NET, OCaml, PHP, PowerShell, Ruby, SWI-Prolog, Unity, Magik, and others.

- [ ] Define an adapter conformance test shared by every adapter module:
      discovery/setup, template registration, launch, breakpoint stop, step,
      evaluate, disconnect, and actionable missing-tool errors.
- [ ] Port adapter modules in demand order rather than embedding them in the
      generic DAP client.
- [ ] Start with the adapters Stephen actually uses; record unsupported
      upstream modules explicitly until ported.
- [ ] Match setup/update commands such as `dap-js-setup`,
      `dap-cpptools-setup`, `dap-codelldb-setup`, and
      `dap-gdb-lldb-setup` where automatic acquisition is appropriate.
- [ ] Keep downloaded adapters outside the source checkout and make versions,
      checksums, update behavior, and offline failures visible.

Full adapter-module parity is not required to declare **daily-driver parity**,
but it is required before claiming parity with the complete installed GNU
package.

## Verification gates

### Gate A — Stephen's daily-driver parity

- [ ] Automated GNU/Jemacs comparison uses the same Python file, breakpoint
      store, configuration choice, and key/command sequence.
- [ ] Both stop on the same lines, expose the same selected frame and locals,
      and update breakpoint positions identically after edits.
- [ ] UI snapshots match pane ownership, labels, focus, refresh, and cleanup.
- [ ] Restart, pytest-at-point, attach, multiple sessions, errors, and terminal
      routing pass in both editors.
- [ ] No placeholder mode or command is counted as implemented.

### Gate B — Core/UI public parity

- [ ] Every interactive command in `dap-mode.el`, `dap-ui.el`, `dap-mouse.el`,
      and `dap-python.el` is implemented or listed in a reviewed incompatibility
      table.
- [ ] Every public custom variable and lifecycle hook has a behavioral test.
- [ ] Real debugpy and js-debug suites pass in TUI and Electron.
- [ ] Package unit tests, integration tests, reload tests, and core tests pass.

### Gate C — Full installed-package parity

- [ ] Every shipped adapter module is implemented or has an explicit supported
      alternative with equivalent user-visible behavior.
- [ ] The public symbol inventory is mechanically compared with the installed
      GNU package in CI so future drift is visible.
- [ ] Documentation no longer uses “parity” for approximations or placeholders.

## Recommended execution order

1. Current-session model and GNU restart semantics.
2. Edit-aware, bidirectionally compatible breakpoint persistence.
3. Lifecycle hooks and auto-configure feature selection.
4. Interactive Sessions/Locals/Expressions/Breakpoints panes.
5. Output buffer, REPL, controls, tooltip, and real hydra.
6. Templates/recent history/tasks/child sessions.
7. Source references, remote paths, missing protocol events, and robustness.
8. Public command/custom inventory closure.
9. Adapter modules in actual-use order.

Do not mark a checklist group complete based only on command registration or a
rendered label. Completion requires a behavioral parity test against Stephen's
installed GNU Emacs configuration.
