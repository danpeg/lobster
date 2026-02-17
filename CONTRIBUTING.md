# Contributing

## Branches

- `main`: stable
- `experimental`: development and experiments

## PR Rules

1. No hardcoded secrets/tokens/IDs.
2. Keep `.env.example` updated for new config.
3. Run before opening PR:
   - `npm run security:scan`
   - `npm run check:plugin-pack`
4. Public-safe only on all branches.
