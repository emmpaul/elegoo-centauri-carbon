# Tasks

## 1. Workflow order

- [x] 1.1 In `.github/workflows/release.yml`, change the `release` job's `needs: verify` to `needs: [verify, image]` (design D1), and leave every other line unchanged. Verify with `git diff` (one line changed) and with `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint`, which should report nothing.
- [x] 1.2 Update "How the pieces fit" in `.claude/skills/release/SKILL.md`: the `image` job runs after verification, and the GitHub release is created once the image is pushed (not "in parallel"). Verify that `grep -n "In parallel" .claude/skills/release/SKILL.md` prints nothing and that the text matches the job graph.

## 2. Integration check

- [x] 2.1 Run `pnpm typecheck` and `pnpm test`, and verify both pass.

## Workflow follow-up

- On the next tag, confirm in the Actions run that `create release` starts after `publish image` succeeds, and that `ghcr.io/emmpaul/elegoo-centauri-carbon:<version>` pulls as soon as the release is visible.
