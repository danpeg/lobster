# Contributing to ClawPilot

Thanks for wanting to contribute! This guide covers everything you need to get started.

## Development Setup

1. **Fork and clone** the repo:
   ```bash
   git clone https://github.com/<your-username>/clawpilot.git
   cd clawpilot
   ```

2. **Install bridge dependencies**:
   ```bash
   cd services/clawpilot-bridge
   npm install
   ```

3. **Set up environment**:
   ```bash
   cp .env.example .env
   # Fill in your Recall.ai and OpenClaw credentials
   ```

4. **Start the bridge** (for development):
   ```bash
   set -a; source ./.env; set +a
   npm start
   ```

5. **Install the plugin** locally:
   ```bash
   cd packages/clawpilot-plugin
   npm pack
   openclaw plugins install ./clawpilot-clawpilot-0.2.0.tgz
   openclaw daemon restart
   ```

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Stable releases |
| `experimental` | Active development, experimental integrations |

- **Bug fixes**: branch from `main`
- **New features**: branch from `experimental`

## Pull Request Checklist

Before opening a PR, make sure you:

- [ ] Run `npm run security:scan` -- no secrets in the codebase
- [ ] Run `npm run check:plugin-pack` -- plugin package builds cleanly
- [ ] Keep `.env.example` updated if you add new config variables
- [ ] No hardcoded secrets, tokens, IDs, or machine-specific paths
- [ ] Tested your changes end-to-end with a live meeting (if applicable)
- [ ] Updated `CHANGELOG.md` with your changes under an `[Unreleased]` section

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(plugin): add /clawpilot leave command
fix(bridge): handle empty transcript payloads
docs: update configuration table in README
chore: bump express to 4.19
```

**Types**: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `security`

**Scopes** (optional): `plugin`, `bridge`, `scripts`

## Code Style

- Plain JavaScript (ES modules)
- No build step required
- Keep dependencies minimal -- every new `npm install` needs justification
- Security-first: validate inputs, restrict network access, never trust external data blindly

## Reporting Issues

- **Bugs**: Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- **Features**: Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
- **Security vulnerabilities**: See [SECURITY.md](SECURITY.md) -- report privately, not as a public issue

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind, be constructive.
