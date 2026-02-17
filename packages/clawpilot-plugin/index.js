const PLUGIN_ID = 'clawpilot';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3001';

function isPrivateIpv4(hostname) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;

  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT range used by Tailscale.
  return false;
}

function isAllowedBridgeHost(hostname) {
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (hostname.endsWith('.ts.net')) return true;
  return isPrivateIpv4(hostname);
}

function normalizeBridgeBaseUrl(rawUrl, allowRemoteBridge) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid bridgeBaseUrl: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported bridgeBaseUrl protocol: ${parsed.protocol}`);
  }

  if (!allowRemoteBridge && !isAllowedBridgeHost(parsed.hostname)) {
    throw new Error(
      `Blocked non-private bridge host "${parsed.hostname}". Set allowRemoteBridge=true only if you trust that endpoint.`
    );
  }

  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
}

function loadBridgeConfig(api) {
  const cfg = api.runtime.config.loadConfig();
  const pluginCfg = cfg?.plugins?.entries?.[PLUGIN_ID]?.config || {};
  const allowRemoteBridge = Boolean(pluginCfg.allowRemoteBridge);
  const bridgeBaseUrl = normalizeBridgeBaseUrl(pluginCfg.bridgeBaseUrl || DEFAULT_BRIDGE_URL, allowRemoteBridge);
  const bridgeToken = pluginCfg.bridgeToken || '';
  return { bridgeBaseUrl, bridgeToken };
}

async function callBridge(api, path, method = 'GET') {
  const { bridgeBaseUrl, bridgeToken } = loadBridgeConfig(api);
  const headers = { 'Content-Type': 'application/json' };
  if (bridgeToken) headers.Authorization = `Bearer ${bridgeToken}`;

  const res = await fetch(`${bridgeBaseUrl}${path}`, { method, headers });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    throw new Error(`Bridge call failed (${res.status}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

export default function register(api) {
  api.registerCommand({
    name: 'clawpilot',
    description: 'Control Recall copilot bridge: status | mute | unmute | verbose-on | verbose-off',
    acceptsArgs: true,
    handler: async (ctx) => {
      const action = (ctx.args || 'status').trim().toLowerCase();

      try {
        if (!action || action === 'status') {
          const status = await callBridge(api, '/copilot/status');
          return { text: `ClawPilot status:\n${JSON.stringify(status, null, 2)}` };
        }
        if (action === 'mute') {
          const result = await callBridge(api, '/mute', 'POST');
          return { text: `Muted.\n${JSON.stringify(result, null, 2)}` };
        }
        if (action === 'unmute') {
          const result = await callBridge(api, '/unmute', 'POST');
          return { text: `Unmuted.\n${JSON.stringify(result, null, 2)}` };
        }
        if (action === 'verbose-on') {
          const result = await callBridge(api, '/meetverbose/on', 'POST');
          return { text: `Verbose ON.\n${JSON.stringify(result, null, 2)}` };
        }
        if (action === 'verbose-off') {
          const result = await callBridge(api, '/meetverbose/off', 'POST');
          return { text: `Verbose OFF.\n${JSON.stringify(result, null, 2)}` };
        }

        return {
          text: [
            'Usage: /clawpilot <action>',
            '',
            'Actions:',
            '- status',
            '- mute',
            '- unmute',
            '- verbose-on',
            '- verbose-off',
          ].join('\n'),
        };
      } catch (err) {
        return { text: `ClawPilot command failed: ${err.message}` };
      }
    },
  });
}
