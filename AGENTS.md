# SMGo agent instructions

Before changing or diagnosing this project:

1. Read `CLAUDE.md` completely. It is the canonical engineering memory for
   architecture, SuperMemo/SMA constraints, collection safety, known failures,
   prior decisions, and the current Endgame operational state.
2. Read the relevant sections of `README.md` for user-facing setup and operating
   instructions. Keep `README.md` concise and keep implementation history in
   `CLAUDE.md`.
3. Treat SuperMemo element IDs and all pending actions as collection-scoped.
   Never apply a command unless its collection ID and protocol match the active
   collection. Do not replay legacy unscoped queues.
4. Keep SMGo and Neuro100x separate. Do not merge their queues, credentials,
   scheduling, grading, storage, or service workers.
5. Preserve unrelated working-tree changes and untracked diagnostic files.
   Never commit credentials or `config.json`.
6. After JavaScript changes, run `npm test` and the relevant `node --check`
   commands. After plugin changes, build the Release SMA project and verify the
   installed DLL hash while SuperMemo and SMA are closed.
7. Update `CLAUDE.md` when a durable constraint, failure mode, architectural
   decision, or operational procedure changes. Update `README.md` only when the
   user-facing workflow changes.

The current active collection and known limitations are recorded in
`CLAUDE.md`; do not infer them from stale exports or process state.
