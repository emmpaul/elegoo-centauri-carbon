---
name: release
description: Cut a release of this repo — bump the version through a PR, tag main, and let the Release workflow publish the GitHub release.
disable-model-invocation: true
---

# release

Ship one version of this repo. A release is **one-way**: a pushed tag and a published
GitHub release are public the moment they exist. So every step ends on a checkable
state, and the run stops at the first state that is off.

How the pieces fit:

- `package.json` `version` is the single source of truth for the version number.
- `main` is protected (PR only, check `typecheck and test` required), so the version bump
  lands through a **release PR**.
- Pushing a `vX.Y.Z` tag starts `.github/workflows/release.yml`. It re-runs the checks,
  verifies the tag equals `v` + `package.json` version and sits on `main`, then creates
  the GitHub release with generated notes. Tags with a `-` suffix (`v1.2.0-rc.1`)
  become prereleases.

## Usage

```
/release                 # version picked from commits since the last tag
/release patch|minor|major
/release 1.4.0           # exact version (or 1.4.0-rc.1)
```

## 1. Preflight

Run from the repo root:

```bash
gh auth status
git status --porcelain
git fetch --tags origin
git describe --tags --abbrev=0 origin/main   # last tag; none on the first release
gh run list --branch main --workflow ci.yml --limit 1 --json headSha,conclusion
```

Preflight is **green** when all hold:

- `gh` is authenticated.
- The working tree is clean (the user's uncommitted work stays theirs; list it and stop).
- The latest `ci.yml` run on `main` is for `origin/main`'s head sha and concluded `success`.
- `origin/main` has commits since the last tag (`git log <last-tag>..origin/main`).
  With none, there is nothing to release: say so and stop.

## 2. Pick the version

Current version: `node -p "require('./package.json').version"`.

- Argument `X.Y.Z` (optionally `-suffix`): use it. It must be greater than the current
  version.
- Argument `patch`, `minor`, or `major`: bump that part.
- No argument: read `git log --format=%s%n%b <last-tag>..origin/main` (all of
  `origin/main` on a first release). Any `!` after the type or a `BREAKING CHANGE:`
  footer → major (minor while the version is `0.x`); else any `feat` → minor; else
  patch.

Show the user the plan: current → next version, the commit subjects going in, and the
tag `vX.Y.Z`. Ask once (the host's question tool when it has one) with the options
`Release vX.Y.Z` and `Stop`. Go on only on `Release vX.Y.Z`.

## 3. Release PR

Make sure that neither the tag nor the branch exists yet:
`git ls-remote --exit-code origin refs/tags/vX.Y.Z` and
`git ls-remote --exit-code origin refs/heads/release/vX.Y.Z` both exit non-zero.

```bash
git switch -c release/vX.Y.Z origin/main
npm pkg set version=X.Y.Z                 # edits package.json only
git add -- package.json
msg=$(mktemp); printf 'chore(release): vX.Y.Z\n' > "$msg"; git commit -F "$msg"; rm -f "$msg"
git push -u origin HEAD:refs/heads/release/vX.Y.Z
gh pr create --base main --head release/vX.Y.Z --title "chore(release): vX.Y.Z" \
  --body "Bump version to X.Y.Z. Merging this, then tagging, publishes release vX.Y.Z."
gh pr checks --watch <pr>
gh pr merge <pr> --rebase --delete-branch
```

Commit messages and the PR body carry no AI attribution (no `Co-Authored-By` for a
model or tool, no "Generated with" line).

The PR step is done when `gh pr view <pr> --json state` is `MERGED`. A red check stops
the run with the PR left open; report the failing check.

## 4. Tag

```bash
git fetch origin
git switch main && git merge --ff-only origin/main
test "$(node -p "require('./package.json').version")" = "X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z" origin/main
git push origin refs/tags/vX.Y.Z
```

The tag goes on the merged release commit at `origin/main`'s head, annotated, and is
pushed by its full ref name. A tag is created once and never moved or force-pushed: when
any step from here on fails, report it and leave the tag for the user to decide on.

## 5. Watch the Release workflow

```bash
gh run list --workflow release.yml --limit 1 --json databaseId,headBranch,status
gh run watch <run-id> --exit-status
gh release view vX.Y.Z --json url,isPrerelease,tagName
```

The release is done when `gh release view vX.Y.Z` returns its URL. A failed run leaves a
tag with no release: report the failing job from `gh run view <run-id> --log-failed`
and stop.

## 6. Report

The version, the release PR, the tag and its sha, the release URL, and anything the run
left behind (an open PR, a tag without a release).
