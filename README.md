<h1 align="center">ClawPilot</h1>

<p align="center">
  <strong>Your AI copilot, live in every meeting.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@clawpilot/clawpilot"><img src="https://img.shields.io/npm/v/@clawpilot/clawpilot?style=for-the-badge" alt="npm version"></a>
  <a href="https://github.com/danpeg/clawpilot/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/danpeg/clawpilot/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  ClawPilot connects <a href="https://recall.ai">Recall.ai</a> live transcripts to <a href="https://openclaw.com">OpenClaw</a> so your AI copilot can join meetings, follow the conversation, and coach you in real time.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> · <a href="#commands">Commands</a> · <a href="#configuration">Configuration</a> · <a href="CONTRIBUTING.md">Contributing</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

---

## Highlights

- **Joins your meetings** — sends a Recall bot to Google Meet, Zoom, or Teams
- **Listens in real time** — streams live transcripts via webhooks
- **Coaches you as you go** — your copilot reacts with ideas, research, and suggestions mid-meeting
- **Mirrors transcripts** — optionally echoes the raw conversation into your chat
- **Meeting canvas** — live notes page with headings, action items, and decisions via SSE
- **Security-first** — bridge restricted to private IPs, HMAC webhook verification, no env leaks

All controlled from your OpenClaw chat with `/clawpilot` commands.

## How it works

```
Google Meet / Zoom / Teams
            │
            ▼
┌───────────────────────┐       webhook        ┌──────────────────────────┐
│     Recall.ai Bot     │ ───────────────────▶  │    ClawPilot Bridge      │
│  (joins & transcribes)│                       │       (Express)          │
└───────────────────────┘                       │                          │
                                                │  ┌─ transcript buffer    │
                                                │  ├─ reaction engine      │
                                                │  └─ meeting canvas (SSE) │
                                                └────────────┬─────────────┘
                                                             │
                                                   /hooks/wake + /hooks/agent
                                                             │
                                                             ▼
                                                ┌──────────────────────────┐
                                                │       OpenClaw           │
                                                │  (coaching responses in  │
                                                │   WhatsApp / Telegram /  │
                                                │   Slack / Discord / …)   │
                                                └──────────────────────────┘

┌───────────────────────┐
│  OpenClaw Plugin      │       HTTP         ┌──────────────────────────┐
│  /clawpilot join …    │ ─────────────────▶ │    ClawPilot Bridge      │
│  /clawpilot pause     │                    │    (control endpoints)   │
│  /clawpilot status    │                    └──────────────────────────┘
└───────────────────────┘
```

## Quick Start

### 1. Install the plugin

```bash
openclaw plugins install @clawpilot/clawpilot
openclaw daemon restart
```

### 2. Start the bridge

```bash
cd services/clawpilot-bridge
cp .env.example .env          # fill in your keys — see Configuration below
set -a; source ./.env; set +a
npm install && npm start
```

### 3. Verify

```bash
curl -s http://127.0.0.1:3001/health        # bridge health
openclaw plugins info clawpilot              # plugin loaded
```

### 4. Join a meeting

In any OpenClaw chat:

```
/clawpilot join https://meet.google.com/abc-defg-hij
/clawpilot join https://meet.google.com/abc-defg-hij --name "Team Note Taker"
```

## Commands

| Command | Description |
|---------|-------------|
| `/clawpilot help` | Show available commands |
| `/clawpilot join <url>` | Send a bot to join a meeting |
| `/clawpilot pause` | Pause copilot reactions |
| `/clawpilot resume` | Resume copilot reactions |
| `/clawpilot transcript on\|off` | Toggle live transcript mirroring |
| `/clawpilot status` | Check bridge and reaction state |

## Configuration

### Required

| Variable | Description |
|----------|-------------|
| `RECALL_API_KEY` | Your Recall.ai API key |
| `RECALL_API_BASE` | Region endpoint (e.g. `https://us-east-1.recall.ai`) |
| `WEBHOOK_SECRET` | HMAC token for webhook verification |
| `WEBHOOK_BASE_URL` | Public HTTPS URL where Recall sends webhooks |
| `OPENCLAW_HOOK_URL` | OpenClaw hook injection endpoint |
| `OPENCLAW_HOOK_TOKEN` | Auth token for OpenClaw hooks |

### Reaction tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `PROACTIVITY_LEVEL` | `normal` | `low` / `normal` / `high` — controls cooldown, word thresholds, context window |
| `REACT_ON_PARTIAL` | `false` | React to partial transcripts (increases token usage) |

### Bot naming

| Variable | Description |
|----------|-------------|
| `OPENCLAW_AGENT_NAME` | Default bot name becomes `<name> Note Taker` |
| `RECALL_BOT_NAME` | Explicit bot name override |
| `RECALL_BOT_NAME_SUFFIX` | Suffix (default: `Note Taker`) |

Full list of 30+ options: [`services/clawpilot-bridge/.env.example`](services/clawpilot-bridge/.env.example)

## Exposing the webhook endpoint

Recall.ai sends transcript events to your bridge via HTTPS webhooks from the public internet. The bridge listens on HTTP (default port 3001), so you need a publicly reachable reverse proxy or tunnel in front of it.

### Option 1: Cloudflare proxy (recommended)

If your domain is already on Cloudflare, this is the quickest path. Add an A record pointing to your server, enable the orange-cloud proxy, and Cloudflare handles TLS termination:

```
clawpilot.yourdomain.com  →  A  →  <your-server-ip>  (Proxied)
```

The bridge stays HTTP internally — Cloudflare terminates TLS at the edge.

Set in your `.env`:
```
WEBHOOK_BASE_URL=https://clawpilot.yourdomain.com
```

### Option 2: Cloudflare Tunnel

No open ports required. Install `cloudflared` and create a tunnel:

```bash
cloudflared tunnel create clawpilot
cloudflared tunnel route dns clawpilot clawpilot.yourdomain.com
cloudflared tunnel run --url http://127.0.0.1:3001 clawpilot
```

### Option 3: Caddy

Automatic TLS via Let's Encrypt. Point a DNS record to your server (not proxied through Cloudflare — use a different domain or grey-cloud the record):

```
# /etc/caddy/Caddyfile
clawpilot.yourdomain.com {
    reverse_proxy 127.0.0.1:3001
}
```

```bash
sudo systemctl reload caddy
```

### Option 4: Nginx + certbot

More manual, but works everywhere:

```nginx
server {
    server_name clawpilot.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo certbot --nginx -d clawpilot.yourdomain.com
```

> **Note:** For local development without a public URL, the bridge includes a [polling fallback](services/clawpilot-bridge/poller.js) that fetches transcripts directly from the Recall API — no webhook endpoint needed.

## Project structure

```
clawpilot/
├─ packages/clawpilot-plugin/      OpenClaw plugin (npm package)
│  ├─ index.js                     /clawpilot command handler
│  └─ openclaw.plugin.json         plugin config schema
├─ services/clawpilot-bridge/      Recall webhook receiver + reaction engine
│  ├─ server.js                    Express server — webhooks, API, meeting canvas
│  ├─ meeting-page.js              live meeting notes with SSE streaming
│  ├─ gateway-client.js            WebSocket client for OpenClaw gateway
│  └─ poller.js                    polling fallback (dev / no-webhook setups)
└─ scripts/
   ├─ bootstrap-recall.sh          interactive setup wizard
   └─ scan-secrets.sh              pre-commit secret scanner
```

## Security

- Plugin **never reads env variables** at runtime — no accidental secret exposure
- Bridge restricted to **localhost + private IPs** by default (RFC 1918 + Tailscale)
- Remote bridges require explicit `allowRemoteBridge: true` opt-in
- Webhook payloads verified via **HMAC token**
- Pre-commit scanning: `npm run security:scan`

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, branch strategy, and PR guidelines.

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md) code of conduct.

## License

[MIT](LICENSE)
