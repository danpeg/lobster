const PLUGIN_ID = 'clawpilot';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3001';

function sanitizeAgentName(value) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.slice(0, 80);
}

function pickFirstNonEmptyString(candidates) {
  for (const value of candidates) {
    const candidate = sanitizeAgentName(value);
    if (candidate) return candidate;
  }
  return '';
}

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

function extractMeetingUrl(text) {
  const input = String(text || '');
  const match = input.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  const url = match[0];
  const allowedMeetingHost = /(meet\.google\.com|([a-z0-9-]+\.)?zoom\.us|teams\.microsoft\.com|teams\.live\.com)$/i;
  try {
    const parsed = new URL(url);
    return allowedMeetingHost.test(parsed.hostname) ? url : null;
  } catch {
    return null;
  }
}

function parseJoinArgs(raw) {
  const input = String(raw || '').trim();
  const nameFlag = /\s--name\s+/i;
  if (!nameFlag.test(input)) {
    return { meetingUrl: extractMeetingUrl(input), botName: '' };
  }

  const parts = input.split(nameFlag);
  const meetingPart = parts[0] || '';
  const namePart = (parts.slice(1).join(' ') || '').trim();
  const unwrappedName = namePart.replace(/^["']|["']$/g, '').trim();
  return {
    meetingUrl: extractMeetingUrl(meetingPart),
    botName: unwrappedName,
  };
}

function buildHelpText() {
  return [
    'ClawPilot commands:',
    '',
    '/clawpilot help',
    '  Show available commands and examples.',
    '',
    '/clawpilot status',
    '  Show bridge + copilot status.',
    '',
    '/clawpilot join <meeting_url> [--name "Bot Name"]',
    '  Join a meeting with Recall bot.',
    '',
    '/clawpilot pause',
    '  Pause transcript processing and reactions.',
    '',
    '/clawpilot resume',
    '  Resume transcript processing and reactions.',
    '',
    '/clawpilot transcript on',
    '/clawpilot transcript off',
    '  Toggle raw transcript mirroring in active chat channel.',
    '',
    'Examples:',
    '/clawpilot join https://meet.google.com/abc-defg-hij',
    '/clawpilot join https://meet.google.com/abc-defg-hij --name "Sunny Note Taker"',
    '/clawpilot transcript on',
  ].join('\n');
}

function inferAgentName(api, ctx) {
  const cfg = api.runtime.config.loadConfig() || {};
  const pluginCfg = cfg?.plugins?.entries?.[PLUGIN_ID]?.config || {};

  const fromPluginConfig = sanitizeAgentName(pluginCfg.agentName);
  if (fromPluginConfig) return fromPluginConfig;

  const fromContext = pickFirstNonEmptyString([
    ctx?.agentName,
    ctx?.agent?.name,
    ctx?.profile?.name,
    ctx?.identity?.name,
    ctx?.assistant?.name,
    ctx?.user?.name,
  ]);
  if (fromContext) return fromContext;

  return pickFirstNonEmptyString([
    cfg?.agent?.name,
    cfg?.assistant?.name,
    cfg?.persona?.name,
    cfg?.agents?.main?.name,
    cfg?.agents?.defaults?.name,
    cfg?.channels?.telegram?.displayName,
    cfg?.channels?.telegram?.name,
  ]);
}

async function callBridge(api, path, options = 'GET') {
  let method = 'GET';
  let body;
  if (typeof options === 'string') {
    method = options;
  } else if (options && typeof options === 'object') {
    method = options.method || 'GET';
    body = options.body;
  }

  const { bridgeBaseUrl, bridgeToken } = loadBridgeConfig(api);
  const headers = { 'Content-Type': 'application/json' };
  if (bridgeToken) headers.Authorization = `Bearer ${bridgeToken}`;

  const request = { method, headers };
  if (body !== undefined) {
    request.body = JSON.stringify(body);
  }

  const res = await fetch(`${bridgeBaseUrl}${path}`, request);
  const text = await res.text();
  let responseBody = text;
  try {
    responseBody = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    throw new Error(`Bridge call failed (${res.status}): ${typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)}`);
  }
  return responseBody;
}

export default function register(api) {
  api.registerCommand({
    name: 'clawpilot',
    description: 'Control ClawPilot: help | status | join | pause | resume | transcript on|off',
    acceptsArgs: true,
    handler: async (ctx) => {
      const rawArgs = (ctx.args || '').trim();
      const [rawAction, ...rest] = rawArgs ? rawArgs.split(/\s+/) : ['help'];
      const action = (rawAction || 'help').toLowerCase();
      const actionArgs = rest.join(' ').trim();

      try {
        if (!action || action === 'help') {
          return { text: buildHelpText() };
        }

        if (action === 'status') {
          const status = await callBridge(api, '/copilot/status');
          return { text: `ClawPilot status:\n${JSON.stringify(status, null, 2)}` };
        }

        if (action === 'join') {
          const parsed = parseJoinArgs(actionArgs);
          if (!parsed.meetingUrl) {
            return {
              text: [
                'Usage:',
                '/clawpilot join <meeting_url>',
                '/clawpilot join <meeting_url> --name "Custom Bot Name"',
                '',
                'Supported: Google Meet, Zoom, Microsoft Teams',
              ].join('\n'),
            };
          }

          const payload = { meeting_url: parsed.meetingUrl };
          if (parsed.botName) payload.bot_name = parsed.botName;
          if (!parsed.botName) {
            const agentName = inferAgentName(api, ctx);
            if (agentName) payload.agent_name = agentName;
          }
          const result = await callBridge(api, '/launch', { method: 'POST', body: payload });
          const launchedName = result?.bot_name ? ` (${result.bot_name})` : '';
          return { text: `Join requested${launchedName}.\n${JSON.stringify(result, null, 2)}` };
        }

        if (action === 'pause') {
          const result = await callBridge(api, '/mute', 'POST');
          return { text: `Paused.\n${JSON.stringify(result, null, 2)}` };
        }

        if (action === 'resume') {
          const result = await callBridge(api, '/unmute', 'POST');
          return { text: `Resumed.\n${JSON.stringify(result, null, 2)}` };
        }

        if (action === 'transcript') {
          const mode = (rest[0] || '').toLowerCase();
          if (mode === 'on') {
            const result = await callBridge(api, '/meetverbose/on', 'POST');
            return { text: `Transcript mirror ON.\n${JSON.stringify(result, null, 2)}` };
          }
          if (mode === 'off') {
            const result = await callBridge(api, '/meetverbose/off', 'POST');
            return { text: `Transcript mirror OFF.\n${JSON.stringify(result, null, 2)}` };
          }
          return {
            text: [
              'Usage:',
              '/clawpilot transcript on',
              '/clawpilot transcript off',
            ].join('\n'),
          };
        }

        return {
          text: [
            `Unknown command: ${action}`,
            '',
            buildHelpText(),
          ].join('\n'),
        };
      } catch (err) {
        return { text: `ClawPilot command failed: ${err.message}` };
      }
    },
  });
}
