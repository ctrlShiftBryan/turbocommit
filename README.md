[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

# turbocommit

Auto-commit after every Claude Code turn.

Captures every prompt/response exchange as a git commit so you never lose
track of what you were doing across sessions and your progress is protected
even when Claude's checkpoint system misbehaves.

## How it works

turbocommit registers a **Stop hook** with Claude Code. After every turn:

- **No file changes?** Creates an `--allow-empty` commit marked with 🫥
- **File changes?** Squashes any contiguous 🫥 commits, combines all
  prompt/response context, and commits everything with `git add -A`

The commit message headline is the first line of your last prompt (max 72
chars). The body contains the full prompt/response transcript for that turn
(and any squashed 🫥 turns).

## Install

```bash
brew install searlsco/tap/turbocommit
turbocommit install
```

Then enable it per-project:

```bash
cd your-repo
turbocommit init
```

## Uninstall

```bash
turbocommit deinit     # disable in a project
turbocommit uninstall  # remove the global hook
brew uninstall turbocommit
```

## Where turbocommit goes in your hook chain

Claude Code runs all Stop hook groups in parallel. `turbocommit install`
appends `turbocommit run` as the **last hook inside the largest existing
Stop group** — which is usually the group most likely to block (e.g.,
prove_it's test/review checks).

This matters because turbocommit is fire-and-forget: it always exits 0
and never blocks Claude. Placing it at the end of the group that does the
real gatekeeping means it runs alongside those checks rather than in a
separate parallel track.

If you rearrange your hooks manually, keep turbocommit at the end of
whichever group contains your stop-or-continue logic.

## Commands

| Command | Description |
|---------|-------------|
| `turbocommit install` | Add Stop hook to `~/.claude/settings.json` |
| `turbocommit uninstall` | Remove it |
| `turbocommit init` | Create `.claude/turbocommit.json` in current repo |
| `turbocommit deinit` | Remove it |
| `turbocommit run` | Hook entry point (called by Claude Code, not manually) |
| `turbocommit help` | Show usage |
| `turbocommit --version` | Show version |

## Requirements

- Node.js >= 18
- Git
- Claude Code

## License

MIT
