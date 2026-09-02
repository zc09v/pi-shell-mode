# pi-shell-mode

A persistent **shell (command line) mode** for pi. Enter the mode, run as many
shell commands as you like, then explicitly leave to return to chat mode.

## Why

Normally each `!command` runs a single command and sends its output to the
model. This package adds a dedicated mode where every line you type is a shell
command, so you can:

- run commands back to back without the `!` prefix
- keep a working directory (`cd` is remembered across commands)
- scroll through command output in a scrollback widget
- recall previous commands with Up/Down

## Usage

| Action | How |
|--------|-----|
| Enter shell mode | `/shell` (or `/sh`) |
| Run a command | type it and press `Enter` |
| Multi-line command | `Shift+Enter` to add a newline |
| Change directory | `cd <path>` (remembered across commands) |
| Clear scrollback | `clear` |
| Kill running command | `Ctrl+C` |
| Recall previous command | `Up` / `Down` |
| **Exit shell mode** | `exit`, `quit`, `/shell`, `Escape`, or `Ctrl+D` (empty line) |

While in shell mode the editor's top border shows `SHELL`, a scrollback widget
appears above the editor with your command history, and the footer shows the
current working directory.

## Install

```bash
# global (all projects)
pi install ./pi-shell-mode

# project-local
pi install -l ./pi-shell-mode

# quick test without installing
pi -e ./pi-shell-mode/extensions/index.ts
```

After installing, restart pi (or `/reload`) to load it.

## Notes

- Commands run through pi's local bash backend in non-interactive mode, so
  pipes, redirection, globs, and env vars all work. Interactive programs
  (vim, htop, ssh, ...) are **not** supported here — use the normal `!command`
  path or an interactive-shell extension for those.
- Shell aliases from your `.bashrc`/`.zshrc` are not expanded by default; see
  the `shellCommandPrefix` setting in pi's docs to enable them.
- Output is capped to the last 500 lines and the last 24 are shown in the
  widget.
