## 1. Tests

- [x] 1.1 Add a test to `test/history-sync.test.ts`: with 27 wanted ids and a silent second Cmd 321, the first 26 jobs are stored, one warning is logged, a change is emitted, and the next sync asks only for the missing id (spec: Later detail request fails)

## 2. Check

- [x] 2.1 `openspec validate update-print-history-spec --strict`, `pnpm typecheck`, and `pnpm test` pass
