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
| Interactive program | `vim`, `htop`, `ssh`, `less`, ... (auto-detected) |
| Clear scrollback | `clear` |
| Kill running command | `Ctrl+C` |
| Recall previous command | `Up` / `Down` |
| **Exit shell mode** | `exit`, `quit`, `/shell`, `Escape`, or `Ctrl+D` (empty line) |

While in shell mode the editor's top border shows `SHELL`, a scrollback widget
appears above the editor with your command history, and the footer shows the
current working directory.

## Install

```bash
# from npm (recommended)
pi install npm:pi-shell-mode

# from this git repository
pi install git:github.com/zc09v/pi-shell-mode

# local checkout (global)
pi install .

# local checkout (project-local)
pi install -l .

# quick test without installing
pi -e ./extensions/index.ts
```

After installing, restart pi (or `/reload`) to load it.

## Notes

- **Interactive programs** (editors, pagers, TUIs, remote shells — see the
  `DEFAULT_INTERACTIVE_COMMANDS` list) are auto-detected: pi's UI temporarily
  suspends, the program runs with full terminal access, then the UI restores.
  Extend the list with the `INTERACTIVE_COMMANDS` env var (comma-separated)
  and remove entries with `INTERACTIVE_EXCLUDE`.
- Everything else runs through pi's local bash backend in non-interactive
  mode, so pipes, redirection, globs, and env vars all work.
- Shell aliases from your `.bashrc`/`.zshrc` are not expanded by default; see
  the `shellCommandPrefix` setting in pi's docs to enable them.
- Output is capped to the last 500 lines and the last 24 are shown in the
  widget.
