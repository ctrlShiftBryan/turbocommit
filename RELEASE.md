# Releasing turbocommit

## Prerequisites

- Push access to searlsco/turbocommit
- Push access to searlsco/homebrew-tap (for formula updates)

## Release Process

### 1. Bump version and commit

```bash
# Edit package.json to bump version
# Then commit with version as message
git add package.json
git commit -m "v0.X.X"
```

### 2. Tag and push

```bash
git tag v0.X.X
git push && git push --tags
```

### 3. Monitor GitHub Actions

The push triggers two workflows:

```bash
# Watch turbocommit actions (runs tests, updates homebrew formula)
gh run list --repo searlsco/turbocommit --limit 3

# Watch homebrew-tap actions (runs brew test-bot)
gh run list --repo searlsco/homebrew-tap --limit 3
```

Wait for both to show `completed success`.

### 4. Verify the release

```bash
brew update
brew reinstall searlsco/tap/turbocommit
turbocommit --version   # Should show new version
turbocommit install     # Re-register hook
```

## Troubleshooting

If homebrew-tap action fails, check:
```bash
gh run view --repo searlsco/homebrew-tap <run-id> --log
```

If formula update didn't trigger, manually check:
```bash
gh run list --repo searlsco/turbocommit --workflow "Update Homebrew Formula"
```
