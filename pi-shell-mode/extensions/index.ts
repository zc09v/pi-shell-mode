/**
 * pi-shell-mode
 *
 * A persistent "shell mode" for pi. Enter with `/shell` (or `/sh`), then type
 * as many shell commands as you like — no `!` prefix, no one-command-at-a-time
 * limit. Exit with `exit` / `quit` / `/shell`, `Escape`, or `Ctrl+D` (on an
 * empty line) to return to normal chat mode.
 *
 * Features:
 *  - Persistent working directory (`cd` works and is remembered).
 *  - Streaming output shown in a scrollback widget above the editor.
 *  - Per-session command history (Up/Down arrows).
 *  - Ctrl+C kills the running command.
 *  - `clear` empties the scrollback.
 *  - Multi-line commands via Shift+Enter.
 *
 * Installation:
 *   pi install ./pi-shell-mode        # project-local: pi install -l ./pi-shell-mode
 *   # quick test without installing:
 *   pi -e ./pi-shell-mode/extensions/index.ts
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import {
  CustomEditor,
  createLocalBashOperations,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const MAX_LINES = 500; // scrollback capacity
const VISIBLE_LINES = 24; // how many lines the widget shows
// Editor border color while shell mode is active. "warning" is yellow in the
// default themes. Change to any theme color ("accent", "success", "error", ...)
// or replace the whole function with a raw ANSI string for a custom color.
const SHELL_BORDER_THEME_COLOR = "warning";

const EXIT_RE = /^(exit|quit|logout|\/shell|\/sh|\/exit)\s*$/i;
const CLEAR_RE = /^clear\s*$/i;
const CD_RE = /^cd(?:\s+(.*))?$/i;

// Commands that need a real terminal (editors, pagers, TUIs, remote shells).
// Extend via INTERACTIVE_COMMANDS (comma-separated) and INTERACTIVE_EXCLUDE.
const DEFAULT_INTERACTIVE_COMMANDS = [
  // Editors
  "vim", "nvim", "vi", "nano", "emacs", "pico", "micro", "helix", "hx", "kak",
  // Pagers
  "less", "more", "most",
  // Interactive git
  "git commit", "git rebase", "git merge", "git cherry-pick", "git revert",
  "git add -p", "git add --patch", "git add -i", "git add --interactive",
  "git stash -p", "git stash --patch", "git reset -p", "git reset --patch",
  "git checkout -p", "git checkout --patch", "git difftool", "git mergetool",
  // System monitors
  "htop", "top", "btop", "glances",
  // File managers
  "ranger", "nnn", "lf", "mc", "vifm",
  // Git TUIs
  "tig", "lazygit", "gitui",
  // Fuzzy finders
  "fzf", "sk",
  // Remote sessions
  "ssh", "telnet", "mosh",
  // Database clients
  "psql", "mysql", "sqlite3", "mongosh", "redis-cli",
  // Kubernetes / Docker
  "kubectl edit", "kubectl exec -it", "docker exec -it", "docker run -it",
  // Other
  "tmux", "screen", "ncdu",
];

function getInteractiveCommands(): string[] {
  const additional =
    process.env.INTERACTIVE_COMMANDS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const excluded = new Set(
    process.env.INTERACTIVE_EXCLUDE?.split(",")
      .map((s) => s.trim().toLowerCase()) ?? [],
  );
  return [...DEFAULT_INTERACTIVE_COMMANDS, ...additional].filter(
    (cmd) => !excluded.has(cmd.toLowerCase()),
  );
}

function isInteractiveCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  for (const cmd of getInteractiveCommands()) {
    const c = cmd.toLowerCase();
    // Match at the start of the command.
    if (trimmed === c || trimmed.startsWith(`${c} `) || trimmed.startsWith(`${c}\t`)) {
      return true;
    }
    // Match after a pipe: "cat file | less".
    const pipeIdx = trimmed.lastIndexOf("|");
    if (pipeIdx !== -1) {
      const afterPipe = trimmed.slice(pipeIdx + 1).trim();
      if (afterPipe === c || afterPipe.startsWith(`${c} `)) {
        return true;
      }
    }
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  // pi's local bash backend (respects the configured shell, streams output).
  const ops = createLocalBashOperations();

  // Per-session state. The extension module is re-evaluated for each session,
  // so this starts fresh on `/new`, `/resume`, `/fork`, etc.
  const state = {
    active: false,
    cwd: process.cwd(),
    lines: [] as string[],
    tui: null as any,
    ui: null as any, // ExtensionUIContext (has setWidget/setStatus/theme)
    running: null as AbortController | null,
    prevEditorFactory: undefined as any, // restore this on exit
    shellBorder: null as ((s: string) => string) | null, // yellow editor border in shell mode
  };

  // -------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------

  function requestRender() {
    try {
      state.tui?.requestRender();
    } catch {
      /* ignore */
    }
  }

  function pushLines(...parts: string[]) {
    state.lines.push(...parts);
    if (state.lines.length > MAX_LINES) state.lines = state.lines.slice(-MAX_LINES);
  }

  /** Append a chunk of command output, splitting on newlines and merging the
   *  trailing partial line with the last buffered line. */
  function appendOutput(chunk: string) {
    const parts = chunk.split("\n");
    if (parts.length === 1) {
      state.lines[state.lines.length - 1] =
        (state.lines[state.lines.length - 1] ?? "") + parts[0]!;
    } else {
      state.lines[state.lines.length - 1] =
        (state.lines[state.lines.length - 1] ?? "") + parts[0]!;
      state.lines.push(...parts.slice(1));
    }
    if (state.lines.length > MAX_LINES) state.lines = state.lines.slice(-MAX_LINES);
  }

  function buildWidgetLines(theme: any, width: number): string[] {
    const visible = state.lines.slice(-VISIBLE_LINES);
    const lines = [
      theme.fg("warning", " ▸ SHELL MODE ") + theme.fg("dim", `· ${state.cwd}`),
      ...visible,
      theme.fg("accent", "> ") + theme.fg("muted", `${state.cwd} $`),
    ];
    return lines.map((l: string) => truncateToWidth(l, width));
  }

  function refreshWidget() {
    if (!state.ui) return;
    state.ui.setWidget("shell-mode", (_tui: any, theme: any) => ({
      render: (width: number) => buildWidgetLines(theme, width),
      invalidate: () => {},
    }));
    requestRender();
  }

  function clearWidget() {
    state.ui?.setWidget("shell-mode", undefined);
  }

  function updateStatus() {
    if (!state.ui) return;
    if (state.active) {
      state.ui.setStatus(
        "shell-mode",
        `${state.ui.theme.fg("warning", "SHELL")} ${state.cwd} · exit/Esc to return`,
      );
    } else {
      state.ui.setStatus("shell-mode", undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Mode enter/exit
  // -------------------------------------------------------------------------

  function enter(ctx: ExtensionContext) {
    if (state.active) return;
    state.active = true;
    state.ui = ctx.ui;
    state.cwd = ctx.cwd ?? state.cwd;
    state.running = null;

    if (state.lines.length === 0) {
      pushLines("Shell mode. Type a command — 'exit', Esc or Ctrl-D returns to chat.");
    }

    // Remember any existing custom editor so we can restore it on exit.
    state.prevEditorFactory = ctx.ui.getEditorComponent?.() ?? undefined;

    // Yellow border so the input box stands out while in shell mode.
    state.shellBorder = (s: string) => ctx.ui.theme.fg(SHELL_BORDER_THEME_COLOR, s);

    ctx.ui.setEditorComponent((tui, _theme, kb) => {
      state.tui = tui;
      return new ShellEditor(tui, _theme, kb);
    });

    refreshWidget();
    updateStatus();
    requestRender();
  }

  function exit() {
    if (!state.active) return;
    state.active = false;
    state.running?.abort();
    state.running = null;

    // Restore the previous editor (default, or another extension's).
    if (state.ui) {
      try {
        state.ui.setEditorComponent(state.prevEditorFactory);
      } catch {
        /* ignore */
      }
    }

    clearWidget();
    updateStatus();
    state.ui = null;
    state.tui = null;
    state.prevEditorFactory = undefined;
    state.shellBorder = null;
  }

  function toggle(ctx: ExtensionContext) {
    if (state.active) exit();
    else enter(ctx);
  }

  // -------------------------------------------------------------------------
  // Command execution
  // -------------------------------------------------------------------------

  // Hand the terminal over to an interactive program (vim, htop, ssh, ...).
  function runInteractive(command: string) {
    const tui = state.tui;
    if (!tui) {
      pushLines("[shell] no terminal available for interactive command");
      refreshWidget();
      return;
    }

    let status: number | null = null;
    let signal: string | null = null;
    let errorMsg: string | null = null;
    try {
      tui.stop();
      process.stdout.write("\x1b[2J\x1b[H");
      const shell = process.env.SHELL || "/bin/sh";
      const result = spawnSync(shell, ["-c", command], {
        stdio: "inherit",
        cwd: state.cwd,
        env: process.env,
      });
      status = result.status ?? null;
      signal = result.signal ?? null;
      errorMsg = result.error?.message ?? null;
    } finally {
      try {
        tui.start();
      } catch {
        /* ignore */
      }
      try {
        tui.requestRender(true);
      } catch {
        /* ignore */
      }
    }

    if (errorMsg) pushLines(`[shell] ${errorMsg}`);
    else if (signal) pushLines(`[killed by ${signal}]`);
    else if (status !== null && status !== 0) pushLines(`[exit ${status}]`);
    refreshWidget();
  }

  async function runCommand(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;

    // Echo the command like a terminal prompt.
    pushLines(`${state.cwd}$ ${trimmed}`);
    requestRender();

    if (EXIT_RE.test(trimmed)) {
      exit();
      return;
    }
    if (CLEAR_RE.test(trimmed)) {
      state.lines = [];
      refreshWidget();
      return;
    }

    // `cd` is a shell builtin; a fresh `bash -c` can't persist it, so we track
    // the working directory ourselves.
    const cdMatch = trimmed.match(CD_RE);
    if (cdMatch) {
      const arg = (cdMatch[1] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
      const target = arg === "" || arg === "~" ? homedir() : arg;
      const next = isAbsolute(target) ? target : resolve(state.cwd, target);
      try {
        if (statSync(next).isDirectory()) state.cwd = next;
        else pushLines(`cd: not a directory: ${arg}`);
      } catch {
        pushLines(`cd: no such directory: ${arg}`);
      }
      updateStatus();
      refreshWidget();
      return;
    }

    // Interactive programs (vim, htop, ssh, ...) get the terminal handed over.
    if (isInteractiveCommand(trimmed)) {
      runInteractive(trimmed);
      return;
    }

    // Run the command, streaming output into the scrollback.
    const ac = new AbortController();
    state.running = ac;
    let exitCode: number | null = null;
    try {
      const res = await ops.exec(trimmed, state.cwd, {
        onData: (chunk: Buffer) => {
          appendOutput(chunk.toString("utf8"));
          requestRender();
        },
        signal: ac.signal,
      });
      exitCode = res.exitCode;
    } catch (err) {
      if (!ac.signal.aborted) {
        appendOutput(`\n[shell] ${(err as Error).message}`);
      }
    } finally {
      if (state.running === ac) state.running = null;
    }

    // Terminate a trailing partial line so the next prompt starts clean.
    if (state.lines.length > 0 && state.lines[state.lines.length - 1] !== "") {
      pushLines("");
    }
    if (exitCode !== null && exitCode !== 0) {
      pushLines(`[exit ${exitCode}]`);
    }
    refreshWidget();
  }

  // -------------------------------------------------------------------------
  // Custom editor: only installed while shell mode is active.
  // -------------------------------------------------------------------------

  class ShellEditor extends CustomEditor {
    private kb: any;

    constructor(tui: any, theme: any, kb: any) {
      super(tui, theme, kb);
      this.kb = kb;
    }

    handleInput(data: string) {
      // Escape → exit shell mode (cancel autocomplete first if it's open).
      if (this.kb.matches(data, "app.interrupt")) {
        if (this.isShowingAutocomplete()) {
          super.handleInput(data);
          return;
        }
        exit();
        return;
      }

      // Ctrl+D on an empty line → exit shell mode.
      if (this.kb.matches(data, "app.exit") && this.getText().length === 0) {
        exit();
        return;
      }

      // Ctrl+C → kill the running command, otherwise clear the editor.
      if (this.kb.matches(data, "app.clear")) {
        if (state.running) {
          state.running.abort();
          state.running = null;
          pushLines("^C");
          refreshWidget();
        } else {
          this.setText("");
        }
        return;
      }

      // Enter → run the command instead of sending it to the model.
      if (this.kb.matches(data, "tui.input.submit")) {
        if (this.isShowingAutocomplete()) {
          super.handleInput(data);
          return;
        }
        this.submitCommand();
        return;
      }

      super.handleInput(data);
    }

    private submitCommand() {
      const text = this.getText();
      this.setText("");
      if (!text.trim()) return;
      this.addToHistory(text);
      void runCommand(text);
    }

    render(width: number): string[] {
      // Yellow (warning) border while in shell mode for visibility.
      if (state.shellBorder) {
        this.borderColor = state.shellBorder;
      }
      const lines = super.render(width);
      if (lines.length === 0) return lines;

      // Label the top border of the editor to signal shell mode.
      const label = " SHELL ";
      const borderChar = "─";
      const pos = Math.max(0, Math.floor((width - label.length) / 2));
      const border = borderChar.repeat(Math.max(0, width));
      const labeled = border.slice(0, pos) + label + border.slice(pos + label.length);
      lines[0] = this.borderColor(labeled.slice(0, width));
      return lines;
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  const command = {
    description: "Enter/exit shell mode (run multiple shell commands)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      toggle(ctx);
    },
  };
  pi.registerCommand("shell", command);
  pi.registerCommand("sh", command);

  pi.on("session_shutdown", () => {
    state.active = false;
    state.running?.abort();
    state.running = null;
    state.tui = null;
    state.ui = null;
    state.shellBorder = null;
  });
}
