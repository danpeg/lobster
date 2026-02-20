const PLUGIN_ID = 'clawpilot';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3001';
const HUMAN_FIRST_NAME_BY_ROUTE = new Map();
const AUTO_JOIN_REPLY_BY_ROUTE = new Map();
const AUTO_JOIN_REPLY_TTL_MS = 8_000;
const LEGACY_MEETING_LAUNCH_BLOCK_REASON =
  'Meeting launch is managed by ClawPilot plugin/bridge. Use /clawpilot join or paste URL.';
const LEGACY_MEETING_LAUNCH_PATTERNS = [
  /(?:^|[\s"'`/])auto-launch-from-text\.sh(?:[\s"'`]|$)/i,
  /(?:^|[\s"'`/])launch-bot\.sh(?:[\s"'`]|$)/i,
  /\/root\/\.openclaw\/recall-webhook\/services\/clawpilot-bridge(?:\/|\b)/i,
  /\/root\/openclaw-meeting-copilot\/services\/clawpilot-bridge(?:\/|\b)/i,
  /\bbash\s+(?:\.[/])?(?:auto-launch-from-text|launch-bot)\.sh(?:\s|$)/i,
];

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
  const autoJoinMeetingLinks = pluginCfg.autoJoinMeetingLinks !== false;
  const autoJoinReplaceActive = Boolean(pluginCfg.autoJoinReplaceActive);
  const blockLegacyMeetingLaunchScripts = pluginCfg.blockLegacyMeetingLaunchScripts !== false;
  return {
    bridgeBaseUrl,
    bridgeToken,
    teamAgent,
    autoJoinMeetingLinks,
    autoJoinReplaceActive,
    blockLegacyMeetingLaunchScripts,
  };
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
  // Normalize common smart dash characters so commands copied from rich text still parse.
  const normalizedInput = input.replace(/[–—―−]/g, '-');
  const nameFlagMatch = normalizedInput.match(/(?:^|\s)-{1,2}name(?:\s+|=)/i);
  if (!nameFlagMatch) {
    return { meetingUrl: extractMeetingUrl(normalizedInput), botName: '' };
  }

  const flagIndex = nameFlagMatch.index ?? -1;
  if (flagIndex < 0) {
    return { meetingUrl: extractMeetingUrl(normalizedInput), botName: '' };
  }

  const meetingPart = normalizedInput.slice(0, flagIndex).trim();
  const namePart = normalizedInput.slice(flagIndex + nameFlagMatch[0].length).trim();
  const unwrappedName = namePart.replace(/^["']|["']$/g, '').trim();
  return {
    meetingUrl: extractMeetingUrl(meetingPart),
    botName: unwrappedName,
  };
}

function buildRouteLookupKey(routeTarget) {
  const channel = sanitizeAgentName(routeTarget?.channel || '').toLowerCase();
  const to = sanitizeAgentName(routeTarget?.to || '');
  if (!channel || !to) return '';
  return `${channel}:${to}`;
}

function buildRouteLookupKeyFromMessageContext(ctx, event = null) {
  const channel = sanitizeAgentName(ctx?.channelId || '').toLowerCase();
  const to = sanitizeAgentName(ctx?.conversationId || event?.to || '');
  if (!channel || !to) return '';
  return `${channel}:${to}`;
}

function queueAutoJoinReply(routeKey, text) {
  pruneExpiredAutoJoinReplies();
  if (!routeKey) return;
  const content = String(text || '').trim();
  if (!content) return;
  AUTO_JOIN_REPLY_BY_ROUTE.set(routeKey, {
    content: content.slice(0, 2000),
    expiresAt: Date.now() + AUTO_JOIN_REPLY_TTL_MS,
  });
}

function consumeAutoJoinReply(routeKey) {
  pruneExpiredAutoJoinReplies();
  if (!routeKey) return '';
  const item = AUTO_JOIN_REPLY_BY_ROUTE.get(routeKey);
  if (!item) return '';
  AUTO_JOIN_REPLY_BY_ROUTE.delete(routeKey);
  if (!item.content || item.expiresAt < Date.now()) return '';
  return item.content;
}

function pruneExpiredAutoJoinReplies(nowMs = Date.now()) {
  for (const [routeKey, item] of AUTO_JOIN_REPLY_BY_ROUTE.entries()) {
    if (!item?.content || !Number.isFinite(item.expiresAt) || item.expiresAt <= nowMs) {
      AUTO_JOIN_REPLY_BY_ROUTE.delete(routeKey);
    }
  }
}

function isDirectMeetingJoinText(text, meetingUrl) {
  const input = String(text || '').trim();
  const url = String(meetingUrl || '').trim();
  if (!input || !url) return false;
  const normalized = input.replace(/[–—―−]/g, '-');
  if (normalized === url) return true;
  const remainder = normalized.replace(url, '').trim();
  if (!remainder) return true;
  if (/^-{1,2}name(?:\s+|=).+/i.test(remainder)) return true;
  return /^join\b/i.test(normalized) && normalized.includes(url);
}

function extractHumanFirstName(value) {
  const normalized = String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';

  const withoutMention = normalized.replace(/^@+/, '');
  if (!withoutMention) return '';
  if (/^(telegram:\d+|\d+)$/i.test(withoutMention)) return '';

  const token = withoutMention.split(' ')[0] || '';
  const clean = token.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ'’]/g, '');
  if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(clean)) return '';
  return sanitizeAgentName(clean);
}

function inferHumanFirstName(ctx, event = null) {
  const metadata = event?.metadata || {};
  const directCandidates = [
    ctx?.firstName,
    ctx?.first_name,
    ctx?.senderFirstName,
    ctx?.sender_first_name,
    ctx?.user?.firstName,
    ctx?.user?.first_name,
    ctx?.sender?.firstName,
    ctx?.sender?.first_name,
    ctx?.author?.firstName,
    ctx?.author?.first_name,
    metadata?.firstName,
    metadata?.first_name,
    metadata?.senderFirstName,
    metadata?.sender_first_name,
  ];
  for (const candidate of directCandidates) {
    const firstName = extractHumanFirstName(candidate);
    if (firstName) return firstName;
  }

  const fullNameCandidates = [
    ctx?.displayName,
    ctx?.display_name,
    ctx?.senderName,
    ctx?.sender_name,
    ctx?.fromName,
    ctx?.from_name,
    ctx?.user?.name,
    ctx?.user?.displayName,
    ctx?.sender?.name,
    ctx?.sender?.displayName,
    ctx?.author?.name,
    ctx?.profile?.name,
    ctx?.identity?.name,
    metadata?.senderName,
    metadata?.sender_name,
    metadata?.displayName,
    metadata?.display_name,
    metadata?.username,
    event?.from,
  ];
  for (const candidate of fullNameCandidates) {
    const firstName = extractHumanFirstName(candidate);
    if (firstName) return firstName;
  }

  return '';
}

function rememberHumanFirstName(ctx, event = null, routeTarget = null) {
  const firstName = inferHumanFirstName(ctx, event);
  if (!firstName) return;
  const routeKey = buildRouteLookupKey(routeTarget);
  if (!routeKey) return;
  HUMAN_FIRST_NAME_BY_ROUTE.set(routeKey, firstName);
}

function inferDefaultLobsterName(ctx, event = null, routeTarget = null) {
  const routeKey = buildRouteLookupKey(routeTarget);
  const firstName = inferHumanFirstName(ctx, event) || (routeKey ? HUMAN_FIRST_NAME_BY_ROUTE.get(routeKey) || '' : '');
  if (!firstName) return '';
  return sanitizeAgentName(`${firstName}'s Lobster 🦞`);
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
    "  Default bot name is <your first name>'s Lobster 🦞.",
    '  Tip: pasting only a meeting URL also triggers join.',
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
    '  Plain text also works in meetings: "mode brainstorm".',
    '',
    '/clawpilot audience <private|shared>',
    '  Set privacy audience policy for the active meeting.',
    '  Plain text also works in meetings: "audience shared".',
    '',
    '/clawpilot privacy',
    '  Show privacy state and owner binding.',
    '',
    'Examples:',
    '/clawpilot join https://meet.google.com/abc-defg-hij',
    '/clawpilot join https://meet.google.com/abc-defg-hij --name "Sunny Note Taker"',
    '/clawpilot transcript on',
    '/clawpilot mode brainstorm',
    '/clawpilot audience shared',
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

  const fromGlobalConfig = pickFirstNonEmptyString([
    cfg?.agent?.name,
    cfg?.assistant?.name,
    cfg?.persona?.name,
    cfg?.agents?.main?.name,
    cfg?.agents?.defaults?.name,
    cfg?.channels?.telegram?.displayName,
    cfg?.channels?.telegram?.name,
  ]);
  if (fromGlobalConfig) return fromGlobalConfig;

  return pickFirstNonEmptyString([
    ctx?.agentName,
    ctx?.agent?.name,
    ctx?.profile?.name,
    ctx?.identity?.name,
    ctx?.assistant?.name,
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

function parseThreadId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
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

function buildRouteTargetFromHook(event, ctx) {
  const metadata = event?.metadata || {};
  const channel = sanitizeAgentName(
    ctx?.channelId || metadata.originatingChannel || metadata.surface || metadata.provider,
  ).toLowerCase();
  const to = sanitizeAgentName(ctx?.conversationId || metadata.originatingTo || metadata.to || event?.from);
  if (!channel || !to) return null;

  const target = { channel, to };
  const accountId = sanitizeAgentName(ctx?.accountId);
  if (accountId) target.accountId = accountId;
  const threadId = parseThreadId(metadata.threadId);
  if (Number.isFinite(threadId)) target.messageThreadId = threadId;
  return target;
}

function buildOwnerBindingFromHook(event, ctx, routeTarget) {
  const metadata = event?.metadata || {};
  const channel = routeTarget?.channel || sanitizeAgentName(ctx?.channelId).toLowerCase();
  const to = routeTarget?.to || sanitizeAgentName(ctx?.conversationId || metadata.originatingTo || metadata.to);
  if (!channel || !to) return null;

  const ownerBinding = { channel, to };
  const accountId = routeTarget?.accountId || sanitizeAgentName(ctx?.accountId);
  if (accountId) ownerBinding.accountId = accountId;
  const senderId = sanitizeAgentName(metadata.senderId || event?.from);
  if (senderId) ownerBinding.senderId = senderId;
  return ownerBinding;
}

function extractToolNameFromHook(event) {
  return sanitizeAgentName(
    event?.toolName || event?.tool_name || event?.name || event?.tool?.name || event?.payload?.toolName || '',
  ).toLowerCase();
}

function stringifyCommandCandidate(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(stringifyCommandCandidate).filter(Boolean).join(' ').trim();
  if (value && typeof value === 'object') {
    for (const key of ['command', 'cmd', 'input', 'text']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

function extractExecCommandFromHook(event, ctx) {
  const candidates = [
    event?.params,
    event?.params?.command,
    event?.params?.cmd,
    event?.params?.args,
    event?.params?.input,
    event?.params?.text,
    event?.command,
    event?.cmd,
    event?.args,
    event?.arguments,
    event?.toolInput,
    event?.input,
    event?.payload,
    ctx?.command,
    ctx?.args,
  ];
  for (const candidate of candidates) {
    const command = stringifyCommandCandidate(candidate);
    if (command) return command;
  }
  return '';
}

function isLegacyMeetingLaunchCommand(rawCommand) {
  const command = String(rawCommand || '');
  if (!command) return false;
  if (LEGACY_MEETING_LAUNCH_PATTERNS.some((pattern) => pattern.test(command))) {
    return true;
  }

  const lower = command.toLowerCase();
  const hasBridgePath =
    lower.includes('/root/.openclaw/recall-webhook/services/clawpilot-bridge') ||
    lower.includes('/root/openclaw-meeting-copilot/services/clawpilot-bridge');
  const hasLauncherScript = /\b(?:auto-launch-from-text|launch-bot)\.sh\b/i.test(command);
  return hasBridgePath && hasLauncherScript;
}

function looksLikeStartupPreferenceText(text) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return false;
  const audienceSignal = /\b(audience|privacy|visibility|private|shared|public|owner-only|owner only)\b/.test(normalized);
  const modeMention = /\b(mode|balanced|brainstorm|weekly|standup|sales|catchup)\b/.test(normalized);
  const changeCue = /\b(set|switch|change|use|move|go|try|update|let's|lets)\b/.test(normalized);
  return audienceSignal || (modeMention && (changeCue || /\bmode\b/.test(normalized)));
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
  const teamAgent = response?.team_agent ? 'yes' : 'no';
  return [
    `Session: ${session}`,
    `Audience: ${audience}`,
    `Team agent: ${teamAgent}`,
    `Owner bound: ${ownerBound}`,
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
    if (res.status === 401) {
      if (!bridgeToken) {
        throw new Error(
          'Bridge call failed (401): Unauthorized. Bridge auth is enabled, but plugin bridgeToken is not configured. Set plugins.entries.clawpilot.config.bridgeToken to match bridge BRIDGE_API_TOKEN, then restart OpenClaw daemon.'
        );
      }
      throw new Error(
        'Bridge call failed (401): Unauthorized. Plugin bridgeToken appears out of sync with bridge BRIDGE_API_TOKEN (or token was rotated). Re-sync bridgeToken, restart OpenClaw daemon, and retry.'
      );
    }
    throw new Error(`Bridge call failed (${res.status}): ${typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)}`);
  }
  return responseBody;
}

export default function register(api) {
  api.on('before_tool_call', (event, ctx) => {
    try {
      const { blockLegacyMeetingLaunchScripts } = loadBridgeConfig(api);
      if (!blockLegacyMeetingLaunchScripts) return;

      const toolName = extractToolNameFromHook(event);
      if (toolName !== 'exec') return;

      const rawCommand = extractExecCommandFromHook(event, ctx);
      if (!isLegacyMeetingLaunchCommand(rawCommand)) return;

      api.logger.warn(`[ClawPilot] blocked legacy meeting launch exec: ${rawCommand.slice(0, 240)}`);
      return {
        block: true,
        blockReason: LEGACY_MEETING_LAUNCH_BLOCK_REASON,
      };
    } catch (err) {
      api.logger.warn(`[ClawPilot] legacy launch guard failed: ${err.message}`);
      return;
    }
  });

  api.on('message_received', async (event, ctx) => {
    try {
      pruneExpiredAutoJoinReplies();
      const text = String(event?.content || '').trim();
      const routeTarget = buildRouteTargetFromHook(event, ctx);
      rememberHumanFirstName(ctx, event, routeTarget);
      const autoJoinArgs = parseJoinArgs(text);
      const { autoJoinMeetingLinks, autoJoinReplaceActive, teamAgent } = loadBridgeConfig(api);
      if (
        autoJoinMeetingLinks &&
        autoJoinArgs.meetingUrl &&
        isDirectMeetingJoinText(text, autoJoinArgs.meetingUrl) &&
        !text.startsWith('/clawpilot')
      ) {
        try {
          const ownerBinding = buildOwnerBindingFromHook(event, ctx, routeTarget);
          const payload = {
            meeting_url: autoJoinArgs.meetingUrl,
            team_agent: teamAgent,
            replace_active: autoJoinReplaceActive,
          };
          if (routeTarget) payload.route_target = routeTarget;
          if (ownerBinding) payload.owner_binding = ownerBinding;
          if (autoJoinArgs.botName) {
            payload.bot_name = autoJoinArgs.botName;
          } else {
            const defaultLobsterName = inferDefaultLobsterName(ctx, event, routeTarget);
            payload.bot_name = defaultLobsterName || 'Lobster 🦞';
          }

          const result = await callBridge(api, '/launch', { method: 'POST', body: payload });
          const routeKey = buildRouteLookupKey(routeTarget);
          queueAutoJoinReply(routeKey, formatJoinSummary(result));
          return;
        } catch (err) {
          const routeKey = buildRouteLookupKey(routeTarget);
          queueAutoJoinReply(routeKey, `ClawPilot auto-join failed: ${err.message}`);
          return;
        }
      }

      if (!text || text.startsWith('/')) return;
      if (!looksLikeStartupPreferenceText(text)) return;

      const ownerBinding = buildOwnerBindingFromHook(event, ctx, routeTarget);
      const body = { text };
      if (routeTarget) body.route_target = routeTarget;
      if (ownerBinding) body.owner_binding = ownerBinding;
      await callBridge(api, '/copilot/startup-input', { method: 'POST', body });
    } catch (err) {
      api.logger.warn(`[ClawPilot] startup-input forward failed: ${err.message}`);
    }
  });

  api.on('message_sending', (event, ctx) => {
    pruneExpiredAutoJoinReplies();
    const routeKey = buildRouteLookupKeyFromMessageContext(ctx, event);
    const queued = consumeAutoJoinReply(routeKey);
    if (!queued) return;
    return { content: queued };
  });

  api.registerCommand({
    name: 'clawpilot',
    description: 'Control ClawPilot: help | status | join | pause | resume | transcript | mode | audience | privacy',
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
                "Default bot name is <your first name>'s Lobster 🦞.",
                '',
                'Supported: Google Meet, Zoom, Microsoft Teams',
              ].join('\n'),
            };
          }

          const payload = { meeting_url: parsed.meetingUrl };
          const routeTarget = buildRouteTarget(ctx);
          rememberHumanFirstName(ctx, null, routeTarget);
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
            const defaultLobsterName = inferDefaultLobsterName(ctx, null, routeTarget);
            if (defaultLobsterName) {
              payload.bot_name = defaultLobsterName;
            } else {
              payload.bot_name = 'Lobster 🦞';
            }
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
