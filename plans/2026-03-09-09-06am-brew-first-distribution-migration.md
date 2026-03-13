# Brew-First Distribution Migration

## Context

turbocommit was transferred from `searlsco/turbocommit` to `ctrlShiftBryan/turbocommit`. The current install mechanism uses absolute `node "/path/cli.js"` paths in hooks, which breaks when moving to a second machine because the paths differ. Brew solves this by putting `turbocommit` on PATH automatically. This plan migrates to brew-first distribution with a new tap and npm scope.

## Phase 1: External Setup (manual, pre-code)

No paid accounts or official registrations needed. Everything is free.

### 1a. npm — first publish (one-time, ~5 min)

- **No org/scope creation needed** — scoped packages under your username (`@ctrlshiftbryan`) work automatically
- **Public scoped packages are free**
- **First publish must be done manually** (OIDC can't create a package that doesn't exist yet):
  ```bash
  # After code changes in Phase 2-4 are done, from your machine:
  npm login                           # if not already logged in
  npm publish --access public         # creates @ctrlshiftbryan/turbocommit on npm
  ```
- **Then set up OIDC trusted publisher** for future automated releases:
  1. Go to npmjs.com → package settings → "Trusted Publishers"
  2. Add: repo `ctrlShiftBryan/turbocommit`, workflow `release.yml`
  3. The existing workflow already has `id-token: write` — no secrets needed after this

### 1b. Homebrew tap (one-time, ~5 min)

- **No registration with Homebrew needed** — a tap is just a GitHub repo
- Steps:
  1. Create **public** repo `ctrlshiftbryan/homebrew-tap` on GitHub
  2. Add `Formula/turbocommit.rb`:
     ```ruby
     class Turbocommit < Formula
       desc "Auto-commit after every Claude Code turn"
       homepage "https://github.com/ctrlShiftBryan/turbocommit"
       url "https://github.com/ctrlShiftBryan/turbocommit/archive/refs/tags/v0.11.0.tar.gz"
       sha256 "PLACEHOLDER"
       license "MIT"
       depends_on "node"

       def install
         libexec.install Dir["*"]
         bin.install_symlink libexec/"cli.js" => "turbocommit"
       end

       test do
         assert_match version.to_s, shell_output("#{bin}/turbocommit --version")
       end
     end
     ```
  3. Create a **fine-grained GitHub PAT** with `contents: write` on the `homebrew-tap` repo
  4. Add that PAT as secret `HOMEBREW_TAP_TOKEN` in `ctrlShiftBryan/turbocommit` repo settings
- Users install with: `brew install ctrlshiftbryan/tap/turbocommit`

## Phase 2: Core Hook Command Change

### `lib/install.js`
- Remove `resolveCliPath()` function
- Change `buildHookDefs()` to use bare `turbocommit` command:
  ```js
  function buildHookDefs () {
    const cmd = 'turbocommit'
    return {
      PreToolUse: { matcher: '...', hooks: [{ type: 'command', command: `${cmd} hook pre-tool-use` }] },
      // ... same pattern for all 4 events
    }
  }
  ```
- Remove `cliPath` parameter from `buildHookDefs()` and `install()`
- Existing `hasTurbocommit()` already matches both old and new formats (checks for substring `'turbocommit'`), so old absolute-path hooks get cleaned up automatically on re-install

### `cli.js`
- Update USAGE text: brew-first install instructions
- Update `cmdInstall()` line 98: `turbocommit init` instead of `node <path>/cli.js init`
- Add PATH check in `cmdInstall()`: warn if `which turbocommit` fails

### `lib/doctor.js`
- Add check after "Hooks installed": detect hooks using `node "` prefix (old absolute-path format), warn user to re-run `turbocommit install`

### Tests
- `test/install.test.js` line 49-50: remove assertions for `startsWith('node ')` and `includes('cli.js')`, assert command equals `turbocommit hook stop`
- `test/install.test.js` line 123: change assertion from `c.startsWith('node ')` to `c.startsWith('turbocommit ')`
- `test/doctor.test.js`: add test for stale absolute-path hook warning

## Phase 3: Package Identity

### `package.json`
- `"name"`: `"@searls/turbocommit"` → `"@ctrlshiftbryan/turbocommit"`
- `"version"`: bump to `0.11.0`
- Verify `"repository"` URL points to `ctrlShiftBryan/turbocommit`

### `.github/workflows/release.yml`
- No code changes needed — OIDC + `npm publish --provenance --access public` reads scope from package.json

### `.github/workflows/update_homebrew_formula.yml`
- `TAP_REPO`: `searlsco/homebrew-tap` → `ctrlshiftbryan/homebrew-tap`
- `OWNER_REPO`: `searlsco/turbocommit` → `ctrlShiftBryan/turbocommit`
- Git user: update `GH_EMAIL` and `GH_NAME` to your GitHub identity

## Phase 4: Documentation

### `README.md`
- Reorder Install section: brew first (recommended), npm second, skills.sh third, remove git clone
- Update all commands from `node cli.js` / `node <path>/cli.js` to `turbocommit`
- Update npm package name to `@ctrlshiftbryan/turbocommit`
- Update brew tap to `ctrlshiftbryan/tap/turbocommit`
- Keep the `searlsco/prove_it` historical commit links as-is

### `SKILL.md`
- Simplify setup to: `brew install ctrlshiftbryan/tap/turbocommit && turbocommit install`
- Remove `node <skill-path>/cli.js` references

### `RELEASE.md`
- Replace all `searlsco` → `ctrlShiftBryan`/`ctrlshiftbryan` as appropriate

## Phase 5: Release

1. Commit all changes
2. Tag `v0.11.0`, push tag
3. Verify: release.yml publishes to npm under new scope, formula workflow updates new tap
4. Test: `brew install ctrlshiftbryan/tap/turbocommit && turbocommit --version`

## Files Changed

| File | Change |
|------|--------|
| `lib/install.js` | Remove `resolveCliPath()`, bare `turbocommit` in hooks, drop `cliPath` params |
| `lib/doctor.js` | Add stale absolute-path hook warning |
| `cli.js` | USAGE text, cmdInstall output, PATH check |
| `package.json` | Name → `@ctrlshiftbryan/turbocommit`, version → `0.11.0` |
| `.github/workflows/update_homebrew_formula.yml` | Point to new tap/repo |
| `README.md` | Brew-first install, update all command examples and npm name |
| `SKILL.md` | Brew-first setup |
| `RELEASE.md` | All searlsco → ctrlShiftBryan |
| `test/install.test.js` | Update command assertions for bare `turbocommit` |
| `test/doctor.test.js` | Add stale-hook-format test |

## Verification

1. `node --test` — all tests pass
2. `turbocommit install` on clean machine — hooks use bare `turbocommit` commands
3. `turbocommit doctor` — reports clean; warns on old absolute-path hooks
4. `brew install ctrlshiftbryan/tap/turbocommit` — installs, `turbocommit --version` works
5. Tag push triggers both release.yml and formula update workflows
