# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x | Yes |
| < 0.2.0 | No |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report them privately:

1. **GitHub Security Advisories** (preferred): Go to the [Security tab](https://github.com/danpeg/clawpilot/security/advisories) and click "Report a vulnerability"
2. **Email**: Contact the maintainers directly (see GitHub profiles for contact info)

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Potential impact

### What to expect

- **Acknowledgment** within 48 hours
- **Status update** within 7 days
- We'll coordinate disclosure timing with you

## Security Design

ClawPilot is designed with security as a core principle:

- **No env fallback in plugin**: The plugin never reads environment variables at runtime, preventing accidental secret exposure
- **Bridge host allowlist**: Only localhost, private IPs (RFC 1918), and Tailscale addresses are allowed by default
- **Explicit remote opt-in**: Remote bridge connections require `allowRemoteBridge: true` in plugin config
- **Webhook HMAC verification**: All transcript webhook payloads are verified via token
- **Pre-commit scanning**: `npm run security:scan` checks for accidentally committed secrets

## Secret Handling

- **Never** commit secrets, tokens, or API keys
- Use environment variables via `.env` files (git-ignored)
- Rotate any leaked credential immediately
- Bridge tokens should be unique per deployment
