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
const LEGACY_PLUGIN_CONFIG_KEYS = [
  'bridgeBaseUrl',
  'bridgeToken',
  'allowRemoteBridge',
  'teamAgent',
  'autoJoinMeetingLinks',
  'autoJoinReplaceActive',
  'manualJoinReplaceActive',
  'blockLegacyMeetingLaunchScripts',
  'agentName',
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

function isAllowedBridgeHost(hostname) {
  if (!hostname) return false;
  if (hostname === 'localhost') return true;
  if (hostname === '127.0.0.1') return true;
  if (hostname === '::1') return true;
  return false;
}

function normalizeBridgeBaseUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid bridgeBaseUrl: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported bridgeBaseUrl protocol: ${parsed.protocol}`);
  }

  if (!isAllowedBridgeHost(parsed.hostname)) {
    throw new Error(
      `Blocked non-local bridge host "${parsed.hostname}". Configure bridgeBaseUrl to localhost/127.0.0.1/::1.`
    );
  }

  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
}

function loadBridgeConfig(api) {
  const cfg = api.runtime.config.loadConfig();
  const pluginEntry = cloneObject(cfg?.plugins?.entries?.[PLUGIN_ID]);
  const { legacyConfig } = splitPluginEntryAndLegacyConfig(pluginEntry);
  const pluginCfg = { ...legacyConfig, ...cloneObject(pluginEntry.config) };
  const bridgeBaseUrl = normalizeBridgeBaseUrl(pluginCfg.bridgeBaseUrl || DEFAULT_BRIDGE_URL);
  const bridgeToken = pluginCfg.bridgeToken || '';
  const teamAgent = Boolean(pluginCfg.teamAgent);
  const autoJoinMeetingLinks = pluginCfg.autoJoinMeetingLinks !== false;
  const autoJoinReplaceActive = Boolean(pluginCfg.autoJoinReplaceActive);
  const manualJoinReplaceActive = pluginCfg.manualJoinReplaceActive !== false;
  const blockLegacyMeetingLaunchScripts = pluginCfg.blockLegacyMeetingLaunchScripts !== false;
  return {
    bridgeBaseUrl,
    bridgeToken,
    teamAgent,
    autoJoinMeetingLinks,
    autoJoinReplaceActive,
    manualJoinReplaceActive,
    blockLegacyMeetingLaunchScripts,
  };
}

function normalizeUrlNoTrailingSlash(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}


function tailOutput(value, maxChars = 260) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3).trimEnd() + '...';
}

async function runSystemCommand(api, argv, timeoutMs = 10_000) {
  try {
    const result = await api.runtime.system.runCommandWithTimeout(argv, {
      timeoutMs,
      noOutputTimeoutMs: timeoutMs,
    });
    const stdout = String(result?.stdout || '').trim();
    const stderr = String(result?.stderr || '').trim();
    return {
      ok: Number(result?.code) === 0,
      code: result?.code,
      stdout,
      stderr,
      combined: [stdout, stderr].filter(Boolean).join('\n').trim(),
    };
  } catch (err) {
    const message = tailOutput(err?.message || err);
    return { ok: false, code: null, stdout: '', stderr: message, combined: message };
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeBridgeHealth(baseUrl) {
  const normalizedBase = normalizeUrlNoTrailingSlash(baseUrl);
  if (!normalizedBase) {
    return { ok: false, code: 0, url: '', reason: 'invalid base URL', body: null };
  }
  const healthUrl = `${normalizedBase}/health`;
  try {
    const res = await fetchWithTimeout(healthUrl, { method: 'GET' });
    const code = Number(res.status || 0);
    const raw = await res.text();
    const body = tryParseJson(raw);
    const bodyOk = body && body.status === 'ok' && body.hook && body.prompt;
    return { ok: code === 200 && Boolean(bodyOk), code, url: healthUrl, reason: bodyOk ? '' : 'unexpected health body', body };
  } catch (err) {
    return { ok: false, code: 0, url: healthUrl, reason: tailOutput(err?.message || err) || 'request failed', body: null };
  }
}

async function probeBridgeAuth(baseUrl, bridgeToken) {
  const normalizedBase = normalizeUrlNoTrailingSlash(baseUrl);
  if (!normalizedBase) {
    return { unauthCode: 0, authCode: 0, reason: 'invalid base URL' };
  }
  const statusUrl = `${normalizedBase}/copilot/status`;
  let unauthCode = 0;
  let authCode = 0;
  let reason = '';
  try {
    const unauthRes = await fetchWithTimeout(statusUrl, { method: 'GET' });
    unauthCode = Number(unauthRes.status || 0);
    await unauthRes.text();
  } catch (err) {
    reason = tailOutput(err?.message || err) || 'unauth probe failed';
    return { unauthCode, authCode, reason };
  }

  if (bridgeToken) {
    try {
      const authRes = await fetchWithTimeout(statusUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bridgeToken}` },
      });
      authCode = Number(authRes.status || 0);
      await authRes.text();
    } catch (err) {
      reason = tailOutput(err?.message || err) || 'auth probe failed';
    }
  }

  return { unauthCode, authCode, reason };
}

function cloneObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

function splitPluginEntryAndLegacyConfig(entry) {
  const pluginEntry = cloneObject(entry);
  const legacyConfig = {};
  for (const key of LEGACY_PLUGIN_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(pluginEntry, key)) {
      legacyConfig[key] = pluginEntry[key];
      delete pluginEntry[key];
    }
  }
  return { pluginEntry, legacyConfig };
}

async function updateClawpilotPluginConfig(api, patch) {
  const cfg = api.runtime.config.loadConfig() || {};
  const plugins = cloneObject(cfg.plugins);
  const entries = cloneObject(plugins.entries);
  const rawPluginEntry = cloneObject(entries[PLUGIN_ID]);
  const { pluginEntry, legacyConfig } = splitPluginEntryAndLegacyConfig(rawPluginEntry);
  const pluginConfig = { ...legacyConfig, ...cloneObject(pluginEntry.config) };
  const nextPluginConfig = { ...pluginConfig, ...patch };
  const nextCfg = {
    ...cfg,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        [PLUGIN_ID]: {
          ...pluginEntry,
          config: nextPluginConfig,
        },
      },
    },
  };
  await api.runtime.config.writeConfigFile(nextCfg);
  return nextPluginConfig;
}

function parseConnectArgs(raw) {
  const normalized = String(raw || '').trim().replace(/[–—―−]/g, '-');
  if (!normalized) return { bridgeUrl: '', bridgeToken: '' };
  const urlMatch = normalized.match(/https?:\/\/[^\s<>"']+/i);
  const bridgeUrl = urlMatch ? urlMatch[0] : '';
  const tokenMatch = normalized.match(/(?:^|\s)(?:--token|-t)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  let bridgeToken = '';
  if (tokenMatch) {
    bridgeToken = tokenMatch[1] || tokenMatch[2] || tokenMatch[3] || '';
  } else {
    const parts = normalized.split(/\s+/).filter(Boolean);
    if (parts.length >= 2 && parts[0].startsWith('http')) {
      bridgeToken = parts[1];
    }
  }
  return { bridgeUrl, bridgeToken: bridgeToken.trim() };
}

function isLocalBridgeUrl(value) {
  try {
    const parsed = new URL(value);
    return isAllowedBridgeHost(parsed.hostname);
  } catch {
    return false;
  }
}

function buildLocalBridgePrimerLines(setupCommand = '/clawpilot setup') {
  return [
    'How ClawPilot works in v1:',
    '- Plugin commands use your local bridge at 127.0.0.1.',
    '- The bridge auto-manages a cloudflared quick tunnel for Recall webhook ingress.',
    '- No Tailscale, ngrok, or Cloudflare account setup is required for v1.',
    '',
    `If setup drifts, rerun ${setupCommand}.`,
  ];
}

function isInstallClassBridgeError(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  if (text.includes('bridge is unreachable')) return true;
  if (text.includes('fetch failed')) return true;
  if (text.includes('connection refused')) return true;
  if (text.includes('econnrefused')) return true;
  if (text.includes('enotfound')) return true;
  if (text.includes('networkerror')) return true;
  if (text.includes('401')) return true;
  if (text.includes('unauthorized')) return true;
  if (text.includes('authentication failed')) return true;
  if (text.includes('bridgetoken')) return true;
  return false;
}

async function runSetupAssistant(api, options = {}) {
  const installMode = options.mode === 'install';
  const setupCommand = installMode ? '/clawpilot install' : '/clawpilot setup';
  const localBridgeUrl = DEFAULT_BRIDGE_URL;
  const lines = [
    installMode ? 'ClawPilot install finalizer' : 'ClawPilot setup assistant',
    installMode
      ? 'I will finalize post-install setup with transparent step-by-step checks.'
      : 'I will show each onboarding step so you can see exactly what I am checking.',
    '',
    ...buildLocalBridgePrimerLines(setupCommand),
    '',
  ];

  const current = loadBridgeConfig(api);
  lines.push(`Step 1/7: Read plugin config -> bridgeBaseUrl=${current.bridgeBaseUrl}`);
  lines.push(`Step 1/7: bridgeToken is ${current.bridgeToken ? 'set' : 'missing'}`);

  if (!isLocalBridgeUrl(current.bridgeBaseUrl)) {
    await updateClawpilotPluginConfig(api, { bridgeBaseUrl: localBridgeUrl });
    lines.push(`Step 2/7: bridgeBaseUrl normalization -> set to ${localBridgeUrl}`);
  } else {
    lines.push(`Step 2/7: bridgeBaseUrl normalization -> already local (${current.bridgeBaseUrl})`);
  }

  const localHealth = await probeBridgeHealth(localBridgeUrl);
  if (!localHealth.ok) {
    lines.push('Step 3/7: Local bridge health -> FAILED');
    lines.push(`Checked ${localHealth.url || `${localBridgeUrl}/health`} and did not get expected bridge health response.`);
    lines.push(`Reason: ${localHealth.reason || `HTTP ${localHealth.code}`}`);
    lines.push(`Start/restart bridge service and rerun ${setupCommand}.`);
    return lines.join('\n');
  }
  lines.push('Step 3/7: Local bridge health -> OK');

  const tunnelState = localHealth.body?.tunnel || {};
  const tunnelUrl = String(tunnelState.public_url || '');
  let tunnelHost = '';
  try {
    tunnelHost = new URL(tunnelUrl).hostname;
  } catch {}
  const tunnelUp = Boolean(tunnelState.up) && /trycloudflare\.com$/i.test(tunnelHost);
  if (!tunnelUp) {
    lines.push('Step 4/7: Cloudflared quick tunnel -> FAILED');
    lines.push('Bridge is healthy but quick tunnel is not ready yet.');
    lines.push(`Tunnel status: ${JSON.stringify({
      status: tunnelState.status || 'unknown',
      up: Boolean(tunnelState.up),
      generation: tunnelState.generation ?? null,
      last_error: tunnelState.last_error || '',
    })}`);
    lines.push(`Wait a few seconds and rerun ${setupCommand}.`);
    return lines.join('\n');
  }
  lines.push(`Step 4/7: Cloudflared quick tunnel -> OK (${tunnelUrl})`);

  const hookTokenSet = Boolean(localHealth.body?.hook?.token_set);
  if (!hookTokenSet) {
    lines.push('Step 5/7: OpenClaw hook token -> ACTION REQUIRED');
    lines.push('Bridge is receiving transcripts but cannot deliver mirrored/copilot output because hooks.token is missing.');
    lines.push('Run locally:');
    lines.push('openclaw config set hooks.path /hooks');
    lines.push('openclaw config set hooks.token <random-secret>');
    lines.push('openclaw daemon restart');
    lines.push('Then restart the bridge process and rerun /clawpilot install.');
    return lines.join('\n');
  }

  let bridgeToken = current.bridgeToken;
  if (!bridgeToken) {
    const envToken = await runSystemCommand(api, ['printenv', 'BRIDGE_API_TOKEN']);
    const candidate = String(envToken.stdout || '').trim();
    if (candidate) {
      bridgeToken = candidate;
      lines.push('Step 5/7: Bridge token auto-discovery -> found BRIDGE_API_TOKEN in runtime environment');
    } else {
      lines.push('Step 5/7: Bridge token auto-discovery -> not found in runtime environment');
    }
  } else {
    lines.push('Step 5/7: Bridge token -> already configured');
  }

  await updateClawpilotPluginConfig(api, {
    bridgeBaseUrl: localBridgeUrl,
    ...(bridgeToken ? { bridgeToken } : {}),
  });
  lines.push('Step 6/7: Saved plugin bridge config');

  const authProbe = await probeBridgeAuth(localBridgeUrl, bridgeToken);
  if (authProbe.unauthCode === 401 && authProbe.authCode === 200) {
    lines.push('Step 7/7: Bridge auth preflight -> OK');
    lines.push('Preflight: auth alignment OK (unauth 401 + auth 200).');
    lines.push('✅ Setup complete. You can now run /clawpilot status or /clawpilot join.');
    return lines.join('\n');
  }
  if (authProbe.unauthCode === 200) {
    lines.push('Step 7/7: Bridge auth preflight -> OK (auth disabled)');
    lines.push('Preflight: bridge auth appears disabled (unauth 200).');
    lines.push('✅ Bridge is reachable. You can run /clawpilot status.');
    return lines.join('\n');
  }
  if (authProbe.unauthCode === 401 && !bridgeToken) {
    lines.push('Step 7/7: Bridge auth preflight -> ACTION REQUIRED');
    lines.push('Preflight: bridge auth is enabled, but plugin still has no bridge token.');
    lines.push('Run this in chat once you have the bridge token:');
    lines.push('/clawpilot connect --token <BRIDGE_API_TOKEN>');
    return lines.join('\n');
  }

  lines.push('Step 7/7: Bridge auth preflight -> FAILED');
  lines.push(`Preflight: bridge auth check incomplete (unauth=${authProbe.unauthCode || 0}, auth=${authProbe.authCode || 0}).`);
  if (authProbe.reason) lines.push(`Reason: ${authProbe.reason}`);
  lines.push('If needed, run:');
  lines.push('/clawpilot connect --token <BRIDGE_API_TOKEN>');
  return lines.join('\n');
}

async function runConnectAssistant(api, rawArgs) {
  const lines = [
    'ClawPilot connect assistant',
    'Applying bridge connection settings from chat and validating them.',
    '',
  ];
  const parsed = parseConnectArgs(rawArgs);
  const current = loadBridgeConfig(api);
  const bridgeUrl = parsed.bridgeUrl || current.bridgeBaseUrl || DEFAULT_BRIDGE_URL;
  const bridgeToken = parsed.bridgeToken || current.bridgeToken;

  if (!isLocalBridgeUrl(bridgeUrl)) {
    lines.push(`Invalid bridge URL: ${bridgeUrl}`);
    lines.push('For v1, bridge URL must be local (localhost/127.0.0.1/::1).');
    lines.push('Usage: /clawpilot connect --token <BRIDGE_API_TOKEN>');
    return lines.join('\n');
  }

  lines.push(`Step 1/3: bridge URL accepted (${DEFAULT_BRIDGE_URL})`);
  lines.push(`Step 2/3: bridge token is ${bridgeToken ? 'provided/set' : 'missing'}`);

  await updateClawpilotPluginConfig(api, {
    bridgeBaseUrl: DEFAULT_BRIDGE_URL,
    ...(bridgeToken ? { bridgeToken } : {}),
  });
  lines.push('Step 3/3: saved plugin bridge config');

  const authProbe = await probeBridgeAuth(DEFAULT_BRIDGE_URL, bridgeToken);
  if (authProbe.unauthCode === 401 && authProbe.authCode === 200) {
    lines.push('Preflight: auth alignment OK (unauth 401 + auth 200).');
    lines.push('✅ Connect complete.');
    return lines.join('\n');
  }
  if (authProbe.unauthCode === 200) {
    lines.push('Preflight: bridge reachable and auth is not enforced (unauth 200).');
    lines.push('✅ Connect complete.');
    return lines.join('\n');
  }
  if (authProbe.unauthCode === 401 && !bridgeToken) {
    lines.push('Bridge auth is enabled (401), but no token was provided.');
    lines.push('Run: /clawpilot connect --token <BRIDGE_API_TOKEN>');
    return lines.join('\n');
  }
  lines.push(`Preflight failed (unauth=${authProbe.unauthCode || 0}, auth=${authProbe.authCode || 0}).`);
  if (authProbe.reason) lines.push(`Reason: ${authProbe.reason}`);
  return lines.join('\n');
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
    '/clawpilot install',
    '  Post-install finalizer (recommended after plugin install/reinstall).',
    '  Runs transparent step-by-step setup checks and remediation.',
    '',
    '/clawpilot setup',
    '  Chat-only onboarding assistant (same checks as install finalizer).',
    '  Includes transparent step-by-step progress and local quick-tunnel checks.',
    '',
    '/clawpilot connect --token <BRIDGE_API_TOKEN>',
    '  Save local bridge auth token from chat and validate auth alignment.',
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
    '  Show privacy state, owner binding, and reveal status.',
    '',
    '/clawpilot reveal <commitments|contacts|context|notes>',
    '  Owner-only one-time reveal grant for shared mode.',
    '',
    'Examples:',
    '/clawpilot install',
    '/clawpilot setup',
    '/clawpilot connect --token <BRIDGE_API_TOKEN>',
    '/clawpilot join https://meet.google.com/abc-defg-hij',
    '/clawpilot join https://meet.google.com/abc-defg-hij --name "Custom Bot Name"',
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

  const status = sanitizeAgentName(result?.status || result?.state);
  if (status) {
    lines.push(`Status: ${status}`);
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

function formatBridgeErrorBody(responseBody) {
  if (typeof responseBody === 'string') {
    return responseBody.slice(0, 500);
  }
  try {
    return JSON.stringify(responseBody).slice(0, 500);
  } catch {
    return String(responseBody).slice(0, 500);
  }
}

function buildBridgeUnauthorizedMessage(bridgeToken) {
  if (!bridgeToken) {
    return [
      'Bridge authentication is enabled, but plugin bridgeToken is not configured.',
      'Set plugins.entries.clawpilot.config.bridgeToken to match BRIDGE_API_TOKEN, then restart OpenClaw daemon.',
      'For chat-only onboarding, run /clawpilot install or /clawpilot connect --token <BRIDGE_API_TOKEN>.',
    ].join(' ');
  }
  return [
    'Bridge authentication failed (401): configured plugin bridgeToken was rejected.',
    'Re-sync plugins.entries.clawpilot.config.bridgeToken with BRIDGE_API_TOKEN (token may have rotated), then restart OpenClaw daemon.',
    'For chat-only onboarding, run /clawpilot install.',
  ].join(' ');
}

function isRecallAuthFailure(responseBody) {
  if (!responseBody || typeof responseBody !== 'object') return false;
  const code = String(responseBody.code || '').toLowerCase();
  if (code === 'authentication_failed') return true;
  const error = String(responseBody.error || '').toLowerCase();
  return error.includes('authentication failed') || error.includes('recall');
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

  let res;
  try {
    res = await fetch(`${bridgeBaseUrl}${path}`, request);
  } catch (err) {
    const causeCode = err?.cause?.code ? ` (${err.cause.code})` : '';
    throw new Error(
      `Bridge is unreachable at ${bridgeBaseUrl}${path}${causeCode}. Verify bridgeBaseUrl is local, ensure bridge service is running, and confirm /health shows tunnel up. Run /clawpilot install for guided chat onboarding.`
    );
  }

  const text = await res.text();
  let responseBody = text;
  try {
    responseBody = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    if (res.status === 401) {
      if (isRecallAuthFailure(responseBody)) {
        throw new Error(
          'Recall API authentication failed. Update RECALL_API_KEY in services/clawpilot-bridge/.env, restart the bridge, then retry.'
        );
      }
      throw new Error(buildBridgeUnauthorizedMessage(bridgeToken));
    }
    throw new Error(`Bridge call failed (${res.status}): ${formatBridgeErrorBody(responseBody)}`);
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
    description: 'Control ClawPilot: help | install | setup | connect | status | join | pause | resume | transcript | mode | audience | privacy | reveal',
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

        if (action === 'setup' || action === 'install') {
          return { text: await runSetupAssistant(api, { mode: action === 'install' ? 'install' : 'setup' }) };
        }

        if (action === 'connect') {
          return { text: await runConnectAssistant(api, actionArgs) };
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
          const { teamAgent, manualJoinReplaceActive } = loadBridgeConfig(api);
          if (routeTarget) {
            console.log(`[ClawPilot] route_target resolved ${JSON.stringify(routeTarget)}`);
          } else {
            console.warn(`[ClawPilot] route_target missing ctx=${JSON.stringify(summarizeRouteContext(ctx))}`);
          }
          if (routeTarget) payload.route_target = routeTarget;
          if (ownerBinding) payload.owner_binding = ownerBinding;
          payload.team_agent = teamAgent;
          payload.replace_active = manualJoinReplaceActive;
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
        const message = String(err?.message || err || 'unknown error');
        if ((action === 'status' || action === 'join') && isInstallClassBridgeError(message)) {
          try {
            const recovery = await runSetupAssistant(api, { mode: 'install' });
            return {
              text: [
                `ClawPilot command failed: ${message}`,
                '',
                'Running guided install recovery now:',
                recovery,
              ].join('\n'),
            };
          } catch (setupErr) {
            const setupMessage = String(setupErr?.message || setupErr || 'unknown error');
            return {
              text: `ClawPilot command failed: ${message}\n\nInstall recovery failed: ${setupMessage}\nTry:\n/clawpilot install`,
            };
          }
        }
        if (/bridge is unreachable|authentication failed|bridgeToken/i.test(message)) {
          return {
            text: `ClawPilot command failed: ${message}\n\nTry chat-only onboarding:\n/clawpilot install`,
          };
        }
        return { text: `ClawPilot command failed: ${message}` };
      }
    },
  });
}
