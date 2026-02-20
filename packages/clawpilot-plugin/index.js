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
  const teamAgent = Boolean(pluginCfg.teamAgent);
  return { bridgeBaseUrl, bridgeToken, teamAgent };
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
    '/clawpilot mode',
    '/clawpilot mode <balanced|brainstorm|weekly|standup|sales|catchup>',
    '  Show or set meeting copilot mode.',
    '',
    '/clawpilot audience <private|shared>',
    '  Set privacy audience policy for the active meeting.',
    '',
    '/clawpilot privacy',
    '  Show privacy state, owner binding, and reveal status.',
    '',
    '/clawpilot reveal <commitments|contacts|context|notes>',
    '  Owner-only one-time reveal grant for shared mode.',
    '',
    'Examples:',
    '/clawpilot join https://meet.google.com/abc-defg-hij',
    '/clawpilot join https://meet.google.com/abc-defg-hij --name "Sunny Note Taker"',
    '/clawpilot transcript on',
    '/clawpilot mode brainstorm',
    '/clawpilot audience shared',
    '/clawpilot reveal context',
  ].join('\n');
}

function formatJoinSummary(result) {
  const lines = [];
  const botName = sanitizeAgentName(result?.bot_name);
  const joinLine = botName ? `Join requested (${botName}).` : 'Join requested.';
  lines.push(joinLine);

  if (typeof result?.id === 'string' && result.id.trim()) {
    lines.push(`Bot ID: \`${result.id.trim()}\``);
  }

  const platform = sanitizeAgentName(result?.meeting_url?.platform).replace(/_/g, ' ');
  const meetingId = sanitizeAgentName(result?.meeting_url?.meeting_id);
  if (platform || meetingId) {
    lines.push(`Meeting: ${[platform, meetingId].filter(Boolean).join(' ')}`);
  }

  if (typeof result?.join_at === 'string' && result.join_at.trim()) {
    lines.push(`Join time: ${result.join_at.trim()}`);
  }

  lines.push('Admit the bot in the meeting when prompted.');
  return lines.join('\n');
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

function buildRouteTarget(ctx) {
  const channel = sanitizeAgentName(ctx?.channelId || ctx?.channel).toLowerCase();
  const to = sanitizeAgentName(ctx?.to || ctx?.from);
  if (!channel || !to) return null;

  const target = { channel, to };
  const accountId = sanitizeAgentName(ctx?.accountId);
  if (accountId) target.accountId = accountId;
  if (typeof ctx?.messageThreadId === 'number' && Number.isFinite(ctx.messageThreadId)) {
    target.messageThreadId = ctx.messageThreadId;
  }
  return target;
}

function summarizeRouteContext(ctx) {
  return {
    channel: sanitizeAgentName(ctx?.channel),
    channelId: sanitizeAgentName(ctx?.channelId),
    to: sanitizeAgentName(ctx?.to),
    from: sanitizeAgentName(ctx?.from),
    senderId: sanitizeAgentName(ctx?.senderId),
    accountId: sanitizeAgentName(ctx?.accountId),
    messageThreadId:
      typeof ctx?.messageThreadId === 'number' && Number.isFinite(ctx.messageThreadId)
        ? ctx.messageThreadId
        : null,
  };
}

function buildOwnerBinding(ctx) {
  const channel = sanitizeAgentName(ctx?.channelId || ctx?.channel).toLowerCase();
  const to = sanitizeAgentName(ctx?.to || ctx?.from);
  if (!channel || !to) return null;
  const ownerBinding = {
    channel,
    to,
  };
  const accountId = sanitizeAgentName(ctx?.accountId);
  if (accountId) ownerBinding.accountId = accountId;
  const senderId = sanitizeAgentName(ctx?.senderId || ctx?.from);
  if (senderId) ownerBinding.senderId = senderId;
  return ownerBinding;
}

function formatModeStatus(response) {
  const session = sanitizeAgentName(response?.session || 'default');
  const mode = sanitizeAgentName(response?.mode || '');
  const defaultMode = sanitizeAgentName(response?.default_mode || '');
  const modes = Array.isArray(response?.available_modes) ? response.available_modes.join(', ') : '';
  return [
    `Session: ${session}`,
    `Mode: ${mode || 'unknown'}`,
    defaultMode ? `Default mode: ${defaultMode}` : '',
    modes ? `Available modes: ${modes}` : '',
  ].filter(Boolean).join('\n');
}

function formatStatusResponse(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return String(status || 'unknown');
  }

  const session = sanitizeAgentName(status?.session || 'default');
  const mode = sanitizeAgentName(status?.mode || '');
  const audience = sanitizeAgentName(status?.audience || 'private');
  const copilotName = sanitizeAgentName(status?.copilot_name || '');
  const reveal = status?.reveal_grant?.category
    ? `${sanitizeAgentName(status.reveal_grant.category)} (${Number(status.reveal_grant.remaining || 0)} remaining)`
    : 'none';
  const defaultMode = sanitizeAgentName(status?.prompt?.default_mode || '');
  const modes = Array.isArray(status?.prompt?.available_modes) ? status.prompt.available_modes.join(', ') : '';
  const bufferedSegmentCount = Number(status?.transcript_segments_buffered);
  const bufferedSegments = Number.isFinite(bufferedSegmentCount) ? bufferedSegmentCount : 0;

  const directAdapters = status?.direct_delivery_adapters && typeof status.direct_delivery_adapters === 'object'
    ? Object.entries(status.direct_delivery_adapters)
      .map(([channel, adapter]) => {
        const label = sanitizeAgentName(channel || '').toLowerCase();
        const enabled = adapter?.enabled ? 'enabled' : 'disabled';
        const configured = adapter?.configured ? 'configured' : 'not configured';
        return label ? `${label} (${enabled}, ${configured})` : '';
      })
      .filter(Boolean)
      .join(', ')
    : '';

  return [
    `Session: ${session}`,
    `Mode: ${mode || 'unknown'}`,
    `Audience: ${audience}`,
    `Muted: ${status?.muted ? 'yes' : 'no'}`,
    `Transcript mirror: ${status?.meetverbose ? 'on' : 'off'}`,
    copilotName ? `Copilot name: ${copilotName}` : '',
    `Team agent: ${status?.team_agent ? 'yes' : 'no'}`,
    `Owner bound: ${status?.owner_bound ? 'yes' : 'no'}`,
    `Reveal grant: ${reveal}`,
    `Reaction in flight: ${status?.reaction_in_flight ? 'yes' : 'no'}`,
    `Queued reaction: ${status?.queued_reaction ? 'yes' : 'no'}`,
    `Buffered transcript segments: ${bufferedSegments}`,
    defaultMode ? `Default mode: ${defaultMode}` : '',
    modes ? `Available modes: ${modes}` : '',
    directAdapters ? `Direct delivery adapters: ${directAdapters}` : '',
  ].filter(Boolean).join('\n');
}

function formatPrivacyStatus(response) {
  const session = sanitizeAgentName(response?.session || 'default');
  const audience = sanitizeAgentName(response?.audience || 'private');
  const ownerBound = response?.owner_bound ? 'yes' : 'no';
  const reveal = response?.reveal_grant?.category
    ? `${sanitizeAgentName(response.reveal_grant.category)} (${Number(response.reveal_grant.remaining || 0)} remaining)`
    : 'none';
  const teamAgent = response?.team_agent ? 'yes' : 'no';
  return [
    `Session: ${session}`,
    `Audience: ${audience}`,
    `Team agent: ${teamAgent}`,
    `Owner bound: ${ownerBound}`,
    `Reveal grant: ${reveal}`,
  ].join('\n');
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
    description: 'Control ClawPilot: help | status | join | pause | resume | transcript | mode | audience | privacy | reveal',
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
          return { text: `ClawPilot status:\n${formatStatusResponse(status)}` };
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
          const routeTarget = buildRouteTarget(ctx);
          const ownerBinding = buildOwnerBinding(ctx);
          const { teamAgent } = loadBridgeConfig(api);
          if (routeTarget) {
            console.log(`[ClawPilot] route_target resolved ${JSON.stringify(routeTarget)}`);
          } else {
            console.warn(`[ClawPilot] route_target missing ctx=${JSON.stringify(summarizeRouteContext(ctx))}`);
          }
          if (routeTarget) payload.route_target = routeTarget;
          if (ownerBinding) payload.owner_binding = ownerBinding;
          payload.team_agent = teamAgent;
          if (parsed.botName) payload.bot_name = parsed.botName;
          if (!parsed.botName) {
            const agentName = inferAgentName(api, ctx);
            if (agentName) payload.agent_name = agentName;
          }
          const result = await callBridge(api, '/launch', { method: 'POST', body: payload });
          return { text: formatJoinSummary(result) };
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

        if (action === 'mode') {
          const requested = (rest[0] || '').toLowerCase();
          if (!requested || requested === 'status' || requested === 'get' || requested === 'list') {
            const modeStatus = await callBridge(api, '/copilot/mode');
            return { text: `Copilot mode:\n${formatModeStatus(modeStatus)}` };
          }
          const result = await callBridge(api, '/copilot/mode', {
            method: 'POST',
            body: { mode: requested },
          });
          return { text: `Mode updated.\n${formatModeStatus(result)}` };
        }

        if (action === 'audience') {
          const requested = (rest[0] || '').toLowerCase();
          if (!requested) {
            return {
              text: [
                'Usage:',
                '/clawpilot audience private',
                '/clawpilot audience shared',
              ].join('\n'),
            };
          }
          const result = await callBridge(api, '/copilot/audience', {
            method: 'POST',
            body: { audience: requested },
          });
          return { text: `Audience updated.\n${formatPrivacyStatus(result)}` };
        }

        if (action === 'privacy') {
          const status = await callBridge(api, '/copilot/privacy');
          return { text: `Copilot privacy:\n${formatPrivacyStatus(status)}` };
        }

        if (action === 'reveal') {
          const category = (rest[0] || '').toLowerCase();
          if (!category) {
            return {
              text: [
                'Usage:',
                '/clawpilot reveal commitments',
                '/clawpilot reveal contacts',
                '/clawpilot reveal context',
                '/clawpilot reveal notes',
              ].join('\n'),
            };
          }
          const ownerBinding = buildOwnerBinding(ctx);
          const result = await callBridge(api, '/copilot/reveal', {
            method: 'POST',
            body: { category, owner_binding: ownerBinding || {} },
          });
          return { text: `Reveal granted.\n${formatPrivacyStatus(result)}` };
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
