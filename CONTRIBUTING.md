# Contributing

## Branches

- `main`: stable
- `experimental`: development and experiments

## PR-First Workflow

1. Sync local main:
   - `git switch main`
   - `git pull --ff-only`
2. Create a topic branch using the project prefix:
   - `git switch -c codex/<short-topic>`
3. Make changes and run required checks.
4. Commit logical units with clear messages.
5. Push branch:
   - `git push -u origin codex/<short-topic>`
6. Open a PR to `main` with:
   - summary of changes
   - risk/impact
   - validation evidence (commands + results)
7. Merge via PR (no direct pushes to `main` for non-emergency work).
8. After merge, delete branch and fast-forward local main.

## PR Rules

1. No hardcoded secrets/tokens/IDs.
2. Keep `.env.example` updated for new config.
3. Run before opening PR:
   - `npm run security:scan`
   - `npm run check:plugin-pack`
4. Public-safe only on all branches.
