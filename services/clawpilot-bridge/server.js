#!/usr/bin/env node
/**
 * Recall.ai Webhook Receiver
 * Receives real-time transcripts and sends copilot reactions via OpenClaw
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const meeting = require('./meeting-page.js');
const {
  createPromptManager,
  FALLBACK_MODE,
  FALLBACK_AUDIENCE,
  normalizeMode,
  normalizeAudience,
  normalizeName
} = require('./prompt-loader.js');
const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

function parseBooleanLike(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'on', 'yes', 'y', 'enable', 'enabled'].includes(normalized)) return true;
    if (['0', 'false', 'off', 'no', 'n', 'disable', 'disabled'].includes(normalized)) return false;
  }

  return fallback;
}

function parseIntegerLike(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : fallback;
}

function sanitizeBotName(value, fallback = '') {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return fallback;
  return normalized.slice(0, 80);
}

function resolveBotName(options = {}) {
  const requested = sanitizeBotName(options.requested || '');
  if (requested) return requested;

  const explicit = sanitizeBotName(process.env.RECALL_BOT_NAME || '');
  if (explicit) return explicit;

  const providedAgentName = sanitizeBotName(options.agentName || '');
  if (providedAgentName) return providedAgentName;

  if (OPENCLAW_AGENT_NAME_DEFAULT) return OPENCLAW_AGENT_NAME_DEFAULT;

  const agentName = sanitizeBotName(
    process.env.OPENCLAW_AGENT_NAME || process.env.CLAW_AGENT_NAME || process.env.AGENT_NAME || ''
  );
  return agentName || 'OpenClaw';
}

// Recall API key for verification
const RECALL_API_KEY = process.env.RECALL_API_KEY;

function readOpenClawHookDefaults() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json');
  function pickFirstString(candidates) {
    for (const value of candidates) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    return '';
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    const portRaw = Number(cfg?.gateway?.port);
    const gatewayPort = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 18789;
    const hooksPathRaw = typeof cfg?.hooks?.path === 'string' ? cfg.hooks.path.trim() : '';
    const hooksPathWithSlash = hooksPathRaw ? (hooksPathRaw.startsWith('/') ? hooksPathRaw : `/${hooksPathRaw}`) : '/hooks';
    const hooksPath = (hooksPathWithSlash.length > 1 ? hooksPathWithSlash.replace(/\/+$/, '') : hooksPathWithSlash) || '/hooks';
    const hookToken = typeof cfg?.hooks?.token === 'string' ? cfg.hooks.token.trim() : '';
    const telegramBotToken = pickFirstString([
      cfg?.channels?.telegram?.botToken,
      cfg?.channels?.telegram?.token,
      cfg?.channels?.telegram?.bot_token
    ]);
    const discordBotToken = pickFirstString([
      cfg?.channels?.discord?.botToken,
      cfg?.channels?.discord?.token,
      cfg?.channels?.discord?.bot_token
    ]);
    const agentName = pickFirstString([
      cfg?.agent?.name,
      cfg?.assistant?.name,
      cfg?.persona?.name,
      cfg?.agents?.main?.name,
      cfg?.agents?.defaults?.name,
      cfg?.channels?.telegram?.displayName,
      cfg?.channels?.telegram?.name
    ]);
    return {
      hookUrl: `http://127.0.0.1:${gatewayPort}${hooksPath}/wake`,
      hookToken,
      telegramBotToken,
      discordBotToken,
      agentName,
      configPath
    };
  } catch {
    return {
      hookUrl: '',
      hookToken: '',
      telegramBotToken: '',
      discordBotToken: '',
      agentName: '',
      configPath
    };
  }
}

const OPENCLAW_HOOK_DEFAULTS = readOpenClawHookDefaults();

// Webhook secret for verifying incoming requests
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const BRIDGE_API_TOKEN = String(process.env.BRIDGE_API_TOKEN || '').trim();
const BRIDGE_AUTH_ENABLED = BRIDGE_API_TOKEN.length > 0;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || `http://127.0.0.1:${PORT}`;
const RECALL_API_BASE = String(process.env.RECALL_API_BASE || 'https://eu-central-1.recall.ai').replace(/\/+$/, '');
const RECALL_BOTS_ENDPOINT = `${RECALL_API_BASE}/api/v1/bot`;
const DEFAULT_RECALL_LANGUAGE = process.env.RECALL_LANGUAGE_CODE || 'en';
const DEFAULT_RECALL_STT_MODE = process.env.RECALL_STT_MODE || 'prioritize_low_latency';
const OPENCLAW_HOOK_URL = OPENCLAW_HOOK_DEFAULTS.hookUrl || 'http://127.0.0.1:18789/hooks/wake';
const OPENCLAW_HOOK_TOKEN = OPENCLAW_HOOK_DEFAULTS.hookToken || '';
const OPENCLAW_AGENT_NAME_DEFAULT = sanitizeBotName(OPENCLAW_HOOK_DEFAULTS.agentName || '');
const OPENCLAW_HOOK_URL_SOURCE = OPENCLAW_HOOK_DEFAULTS.hookUrl ? 'openclaw.json' : 'builtin-default';
const OPENCLAW_HOOK_TOKEN_SOURCE = OPENCLAW_HOOK_DEFAULTS.hookToken ? 'openclaw.json' : 'missing';
const REPLACE_ACTIVE_ON_DUPLICATE = process.env.REPLACE_ACTIVE_ON_DUPLICATE !== 'false';
const BOT_REPLACE_WAIT_TIMEOUT_MS = Number(process.env.BOT_REPLACE_WAIT_TIMEOUT_MS || 45000);
const BOT_REPLACE_POLL_MS = Number(process.env.BOT_REPLACE_POLL_MS || 1500);
const MEETING_TRANSCRIPT_TO_CANVAS = process.env.MEETING_TRANSCRIPT_TO_CANVAS !== 'false';
const MEETING_MIRROR_TO_DEFAULT = process.env.MEETING_MIRROR_TO_DEFAULT !== 'false';
const MEETING_TRANSCRIPT_MAX_CHARS = Number(process.env.MEETING_TRANSCRIPT_MAX_CHARS || 360);

// Optional Telegram bridge settings for debug/typing feedback
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_BOT_TOKEN = OPENCLAW_HOOK_DEFAULTS.telegramBotToken || '';
const TELEGRAM_BOT_TOKEN_SOURCE = OPENCLAW_HOOK_DEFAULTS.telegramBotToken ? 'openclaw.json' : 'missing';
const DEBUG_MIRROR_TELEGRAM = parseBooleanLike(process.env.DEBUG_MIRROR_TELEGRAM, false);
const CONTROL_SPEAKER_REGEX = process.env.CONTROL_SPEAKER_REGEX || '';
const DISCORD_BOT_TOKEN = OPENCLAW_HOOK_DEFAULTS.discordBotToken || '';
const DISCORD_BOT_TOKEN_SOURCE = OPENCLAW_HOOK_DEFAULTS.discordBotToken ? 'openclaw.json' : 'missing';
const DISCORD_DIRECT_DELIVERY = parseBooleanLike(process.env.DISCORD_DIRECT_DELIVERY, true);
const DISCORD_MAX_MESSAGE_CHARS = 2000;
const DISCORD_DIRECT_MAX_RETRIES = 2;
const DISCORD_DIRECT_RETRY_BASE_MS = 1000;
const OPENCLAW_CLI_BIN = String(process.env.OPENCLAW_CLI_BIN || 'openclaw').trim() || 'openclaw';
const OPENCLAW_COPILOT_CLI_ROUTED = parseBooleanLike(process.env.OPENCLAW_COPILOT_CLI_ROUTED, true);
const OPENCLAW_AGENT_CLI_TIMEOUT_MS = Number(process.env.OPENCLAW_AGENT_CLI_TIMEOUT_MS || 45000);
const OPENCLAW_MESSAGE_CLI_TIMEOUT_MS = Number(process.env.OPENCLAW_MESSAGE_CLI_TIMEOUT_MS || 20000);
const BRIDGE_STATE_FILE_RAW = String(process.env.BRIDGE_STATE_FILE || '.bridge-state.json').trim();
const BRIDGE_STATE_FILE = path.isAbsolute(BRIDGE_STATE_FILE_RAW)
  ? BRIDGE_STATE_FILE_RAW
  : path.join(__dirname, BRIDGE_STATE_FILE_RAW);
const LOBSTER_PROMPT_PATH = path.resolve(
  process.env.LOBSTER_PROMPT_PATH || path.join(__dirname, 'prompts', 'lobster.md')
);
const promptManager = createPromptManager({ promptPath: LOBSTER_PROMPT_PATH });
const ALLOWED_REVEAL_CATEGORIES = new Set(['commitments', 'contacts', 'context', 'notes']);
const DEFAULT_MEETING_START_PROMPT = [
  '**{{COPILOT_NAME}} is ready for this meeting.**',
  'Defaults now: mode=`{{ACTIVE_MODE}}`, audience=`{{ACTIVE_AUDIENCE}}`.',
  'Change anytime with plain text (`mode brainstorm`, `audience shared`) or `/clawpilot privacy`.'
].join('\n');
let cachedMeetingStartPrompt = null;

if (DISCORD_DIRECT_DELIVERY && !DISCORD_BOT_TOKEN) {
  console.warn('[DiscordDirect] DISCORD_DIRECT_DELIVERY enabled but Discord bot token was not found in openclaw.json. Falling back to OpenClaw hooks.');
}
if (OPENCLAW_COPILOT_CLI_ROUTED) {
  console.log(`[CopilotCLI] enabled cli_bin=${OPENCLAW_CLI_BIN}`);
}

// Debug mode - mirror raw final transcripts to active OpenClaw chat channel.
// Optional Telegram mirroring can be enabled via DEBUG_MIRROR_TELEGRAM=true.
let DEBUG_MODE = parseBooleanLike(process.env.DEBUG_MODE, false);

// Mute mode - stop processing transcripts (save tokens)
let IS_MUTED = false;

function deriveAgentHookUrl(wakeUrl) {
  try {
    const parsed = new URL(wakeUrl);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/wake$/, '/agent');
    if (!parsed.pathname.endsWith('/agent')) {
      parsed.pathname = `${parsed.pathname}/agent`.replace(/\/{2,}/g, '/');
    }
    return parsed.toString();
  } catch (err) {
    return wakeUrl.replace(/\/+$/, '').replace(/\/wake$/, '/agent');
  }
}

const OPENCLAW_AGENT_HOOK_URL = deriveAgentHookUrl(OPENCLAW_HOOK_URL);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function splitDiscordMessage(content, maxChars = DISCORD_MAX_MESSAGE_CHARS) {
  const text = String(content ?? '');
  if (!text.trim()) return [];
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars);
    if (splitAt < Math.floor(maxChars * 0.5)) {
      splitAt = remaining.lastIndexOf(' ', maxChars);
    }
    if (splitAt < Math.floor(maxChars * 0.5)) {
      splitAt = maxChars;
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length) {
    chunks.push(remaining);
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function extractPromptSection(raw, sectionName) {
  const target = String(sectionName || '').trim();
  if (!target) return '';
  const lines = String(raw || '').split(/\r?\n/);
  let capturing = false;
  const bucket = [];
  for (const line of lines) {
    const header = line.match(/^##\s+(.+?)\s*$/);
    if (header) {
      if (capturing) break;
      capturing = String(header[1] || '').trim() === target;
      continue;
    }
    if (capturing) bucket.push(line);
  }
  return bucket.join('\n').trim();
}

function normalizeMeetingStartTemplate(section) {
  const lines = String(section || '').split(/\r?\n/);
  const templateLine = lines.findIndex((line) => /^Use this template:\s*$/i.test(String(line).trim()));
  const candidate = templateLine >= 0 ? lines.slice(templateLine + 1) : lines.filter((line) => !String(line).trim().startsWith('- '));
  return candidate.join('\n').trim();
}

function getMeetingStartPromptTemplate() {
  if (typeof cachedMeetingStartPrompt === 'string') {
    return cachedMeetingStartPrompt;
  }
  try {
    const promptPath = promptManager.getPromptPath();
    const raw = fs.readFileSync(promptPath, 'utf8');
    const section = extractPromptSection(raw, 'MEETING_START_PROMPT');
    const template = normalizeMeetingStartTemplate(section);
    cachedMeetingStartPrompt = template || DEFAULT_MEETING_START_PROMPT;
  } catch {
    cachedMeetingStartPrompt = DEFAULT_MEETING_START_PROMPT;
  }
  return cachedMeetingStartPrompt;
}

function getDiscordRetryDelayMs(response, parsedBody, attempt) {
  const bodyRetry = Number(parsedBody?.retry_after);
  if (Number.isFinite(bodyRetry) && bodyRetry > 0) {
    return Math.max(250, Math.ceil(bodyRetry * 1000));
  }

  const headerRetryRaw = response?.headers?.get?.('retry-after');
  const headerRetry = Number(headerRetryRaw);
  if (Number.isFinite(headerRetry) && headerRetry > 0) {
    // Treat small values as seconds, large values as milliseconds.
    return Math.max(250, Math.ceil(headerRetry < 100 ? headerRetry * 1000 : headerRetry));
  }

  return DISCORD_DIRECT_RETRY_BASE_MS * Math.max(1, attempt);
}

function formatDiscordError(parsedBody, raw) {
  if (parsedBody && typeof parsedBody.message === 'string') {
    return parsedBody.message;
  }
  const text = String(raw || '').trim();
  if (!text) return 'Unknown Discord API error';
  return text.slice(0, 240);
}

async function postToDiscordDirect(channelId, content) {
  const sendStart = Date.now();
  const chunks = splitDiscordMessage(content, DISCORD_MAX_MESSAGE_CHARS);
  if (!chunks.length) {
    return { ok: false, error: 'Message is empty', elapsed: 0, chunksTotal: 0, chunksSent: 0 };
  }

  const totalAttempts = DISCORD_DIRECT_MAX_RETRIES + 1;
  let chunksSent = 0;
  let messageId = null;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    let delivered = false;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ content: chunk })
        });

        const raw = await response.text();
        const parsedBody = safeParseJson(raw);
        if (response.ok) {
          delivered = true;
          chunksSent += 1;
          messageId = parsedBody?.id || messageId;
          break;
        }

        const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
        if (retryable && attempt < totalAttempts) {
          const waitMs = getDiscordRetryDelayMs(response, parsedBody, attempt);
          console.warn(
            `[DiscordDirect] retry route=${channelId} chunk=${i + 1}/${chunks.length} status=${response.status} attempt=${attempt}/${totalAttempts} wait_ms=${waitMs}`
          );
          await sleep(waitMs);
          continue;
        }

        return {
          ok: false,
          error: formatDiscordError(parsedBody, raw),
          status: response.status,
          elapsed: Date.now() - sendStart,
          chunksTotal: chunks.length,
          chunksSent
        };
      } catch (error) {
        if (attempt < totalAttempts) {
          const waitMs = DISCORD_DIRECT_RETRY_BASE_MS * attempt;
          console.warn(
            `[DiscordDirect] retry route=${channelId} chunk=${i + 1}/${chunks.length} attempt=${attempt}/${totalAttempts} error=${error.message} wait_ms=${waitMs}`
          );
          await sleep(waitMs);
          continue;
        }
        return {
          ok: false,
          error: error.message,
          elapsed: Date.now() - sendStart,
          chunksTotal: chunks.length,
          chunksSent
        };
      }
    }

    if (!delivered) {
      return {
        ok: false,
        error: 'Direct delivery retries exhausted',
        elapsed: Date.now() - sendStart,
        chunksTotal: chunks.length,
        chunksSent
      };
    }
  }

  return {
    ok: true,
    elapsed: Date.now() - sendStart,
    chunksTotal: chunks.length,
    chunksSent,
    messageId
  };
}

const DIRECT_CHANNEL_ADAPTERS = {
  discord: {
    isEnabled: () => DISCORD_DIRECT_DELIVERY,
    isConfigured: () => Boolean(DISCORD_BOT_TOKEN),
    tokenSource: () => DISCORD_BOT_TOKEN_SOURCE,
    deliver: async (routeTarget, content) => postToDiscordDirect(routeTarget.to, content)
  }
};

function formatRouteText(routeTarget, fallback = 'wake') {
  return routeTarget ? `${routeTarget.channel}:${routeTarget.to}` : fallback;
}

function getDirectAdapter(routeTarget) {
  const channel = routeTarget?.channel;
  if (!channel) return null;
  return DIRECT_CHANNEL_ADAPTERS[channel] || null;
}

function getDirectDeliveryStatus() {
  const status = {};
  for (const [channel, adapter] of Object.entries(DIRECT_CHANNEL_ADAPTERS)) {
    status[channel] = {
      enabled: Boolean(adapter.isEnabled()),
      configured: Boolean(adapter.isConfigured()),
      token_source: adapter.tokenSource ? adapter.tokenSource() : 'unknown'
    };
  }
  return status;
}

async function tryDirectDelivery(routeTarget, content) {
  const adapter = getDirectAdapter(routeTarget);
  if (!adapter || !routeTarget?.to) {
    return { considered: false, attempted: false, delivered: false, result: null, reason: 'no_adapter' };
  }

  if (!adapter.isEnabled()) {
    return { considered: true, attempted: false, delivered: false, result: null, reason: 'disabled' };
  }

  if (!adapter.isConfigured()) {
    return { considered: true, attempted: false, delivered: false, result: null, reason: 'not_configured' };
  }

  const result = await adapter.deliver(routeTarget, content);
  if (result.ok) {
    return { considered: true, attempted: true, delivered: true, result, reason: 'ok' };
  }
  return { considered: true, attempted: true, delivered: false, result, reason: 'failed' };
}

async function postToOpenClawJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENCLAW_HOOK_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const raw = await response.text();
  const result = safeParseJson(raw) || { ok: response.ok, raw };
  return { response, result };
}

function extractJsonFromCliOutput(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  const firstJsonLine = lines.findIndex((line) => line.trim().startsWith('{'));
  if (firstJsonLine >= 0) {
    const candidate = lines.slice(firstJsonLine).join('\n').trim();
    const parsed = safeParseJson(candidate);
    if (parsed) return parsed;
  }
  return safeParseJson(raw);
}

function runOpenClawCli(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW_CLI_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`openclaw cli timeout after ${timeoutMs}ms`));
    }, Math.max(1000, timeoutMs));

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').slice(0, 800);
        reject(new Error(`openclaw cli exited ${code}${details ? `: ${details}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function extractAgentText(cliJson) {
  const payloads = cliJson?.result?.payloads;
  if (!Array.isArray(payloads)) return '';
  for (const payload of payloads) {
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (text) return text;
  }
  return '';
}

async function generateCopilotTextViaCli(prompt, routeTarget) {
  const args = ['agent', '--json', '--message', prompt];
  if (routeTarget?.channel) args.push('--channel', routeTarget.channel);
  if (routeTarget?.to) args.push('--to', routeTarget.to);
  const { stdout } = await runOpenClawCli(args, OPENCLAW_AGENT_CLI_TIMEOUT_MS);
  const parsed = extractJsonFromCliOutput(stdout);
  const text = extractAgentText(parsed);
  if (!text) {
    throw new Error('openclaw agent produced an empty response');
  }
  return text;
}

async function deliverTextViaCli(routeTarget, text) {
  const args = [
    'message',
    'send',
    '--json',
    '--channel',
    routeTarget.channel,
    '--target',
    routeTarget.to,
    '--message',
    text
  ];
  if (routeTarget.accountId) {
    args.push('--account', routeTarget.accountId);
  }
  if (Number.isFinite(routeTarget.messageThreadId)) {
    args.push('--thread-id', String(routeTarget.messageThreadId));
  }
  const { stdout } = await runOpenClawCli(args, OPENCLAW_MESSAGE_CLI_TIMEOUT_MS);
  const parsed = extractJsonFromCliOutput(stdout);
  const ok = parsed?.payload?.ok;
  if (ok === false) {
    throw new Error(`openclaw message send failed: ${JSON.stringify(parsed?.payload || parsed)}`);
  }
  return parsed;
}

async function sendDebugTranscript(speaker, text, isPartial, options = {}) {
  if (!DEBUG_MODE) return;

  const prefix = isPartial ? '[RAW PARTIAL]' : '[RAW FINAL]';
  await sendVerboseMirrorToOpenClaw(`${prefix} ${speaker}: ${text}`, options);

  if (!DEBUG_MIRROR_TELEGRAM || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const https = require('https');
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const postData = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: `${prefix} ${speaker}: ${text}`,
      disable_notification: true
    });

    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }}, () => {});
    req.on('error', () => {});
    req.write(postData);
    req.end();
  } catch (e) {}
}

async function sendVerboseMirrorToOpenClaw(line, options = {}) {
  const sendStart = Date.now();
  const routeTarget = resolveRouteTarget(options.routeTarget, options.botId);
  const routeText = formatRouteText(routeTarget, 'last');
  let direct = null;
  try {
    // Avoid hook-path NO_REPLY/suppression for mirrored transcript lines.
    if (OPENCLAW_COPILOT_CLI_ROUTED && routeTarget?.channel && routeTarget?.to) {
      try {
        await deliverTextViaCli(routeTarget, line);
        const elapsed = Date.now() - sendStart;
        console.log(`[VerboseMirror] ${elapsed}ms - delivered_cli route=${routeText}`);
        return { ok: true };
      } catch (cliError) {
        console.warn(`[VerboseMirror] cli path failed route=${routeText} error=${cliError.message} fallback=openclaw`);
      }
    }

    direct = await tryDirectDelivery(routeTarget, line);
    if (direct.delivered) {
      const directResult = direct.result;
      const elapsed = Date.now() - sendStart;
      console.log(
        `[VerboseMirror] ${elapsed}ms - delivered_direct route=${routeText} chunks=${directResult.chunksSent}/${directResult.chunksTotal}`
      );
      return directResult;
    }
    if (direct.reason === 'failed') {
      console.warn(
        `[VerboseMirror] direct failed route=${routeText} error=${direct.result?.error || 'unknown'} fallback=openclaw`
      );
    }

    if (!OPENCLAW_HOOK_TOKEN) {
      console.error('[VerboseMirror] OPENCLAW_HOOK_TOKEN is required.');
      return null;
    }

    const payload = {
      message: `[MEETVERBOSE MIRROR]\nReply with exactly this line and nothing else:\n${line}`,
      name: 'ClawPilot Verbose',
      wakeMode: 'now',
      deliver: true
    };
    if (routeTarget?.channel) payload.channel = routeTarget.channel;
    if (routeTarget?.to) payload.to = routeTarget.to;

    const { response, result } = await postToOpenClawJson(OPENCLAW_AGENT_HOOK_URL, payload);

    const elapsed = Date.now() - sendStart;
    const usedFallback = direct?.attempted || direct?.reason === 'not_configured';
    const statusText = response.ok
      ? (usedFallback ? 'fallback_openclaw' : 'accepted')
      : (usedFallback ? 'failed_after_direct' : 'failed');
    console.log(`[VerboseMirror] ${elapsed}ms - ${statusText} route=${routeText}`);
    return result;
  } catch (error) {
    console.error("[VerboseMirror] Error:", error.message);
    return null;
  }
}

// Send "typing" indicator to Telegram
let lastTypingTime = 0;
async function sendTypingIndicator() {
  const now = Date.now();
  // Only send every 4 seconds (Telegram typing lasts ~5s)
  if (now - lastTypingTime < 4000 || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  lastTypingTime = now;
  
  try {
    const https = require('https');
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`;
    const postData = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, action: 'typing' });
    
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }}, () => {});
    req.on('error', () => {}); // Ignore errors
    req.write(postData);
    req.end();
  } catch (e) {}
}

// Transcript buffer - accumulates conversation
let transcriptBuffer = [];
let lastReactionTime = 0;
let lastPartialReactionTime = 0;
let lastReactionContextKey = '';
let reactionInFlight = false;
let queuedReaction = null;
let queuedReactionTimer = null;
let reactionSeq = 0;
const PROACTIVITY_LEVEL = String(process.env.PROACTIVITY_LEVEL || 'high').toLowerCase();
const PROACTIVITY_PRESETS = {
  low: { reactionCooldownMs: 4200, partialDebounceMs: 5200, minNewWords: 20, partialMinNewWords: 18, partialContextWindow: 8, finalContextWindow: 10 },
  normal: { reactionCooldownMs: 2400, partialDebounceMs: 3200, minNewWords: 14, partialMinNewWords: 12, partialContextWindow: 10, finalContextWindow: 12 },
  high: { reactionCooldownMs: 1100, partialDebounceMs: 1800, minNewWords: 8, partialMinNewWords: 6, partialContextWindow: 12, finalContextWindow: 14 }
};
const selectedProactivity = PROACTIVITY_PRESETS[PROACTIVITY_LEVEL] || PROACTIVITY_PRESETS.high;
const REACT_ON_PARTIAL = parseBooleanLike(process.env.REACT_ON_PARTIAL, false);
const REACTION_COOLDOWN_MS = parseIntegerLike(process.env.REACTION_COOLDOWN_MS, selectedProactivity.reactionCooldownMs); // Finals
const PARTIAL_REACTION_DEBOUNCE_MS = parseIntegerLike(process.env.PARTIAL_REACTION_DEBOUNCE_MS, selectedProactivity.partialDebounceMs); // Partials
const MIN_NEW_WORDS = parseIntegerLike(process.env.MIN_NEW_WORDS, selectedProactivity.minNewWords); // Finals
const PARTIAL_MIN_NEW_WORDS = parseIntegerLike(process.env.PARTIAL_MIN_NEW_WORDS, selectedProactivity.partialMinNewWords); // Partials
const PARTIAL_CONTEXT_WINDOW = parseIntegerLike(process.env.PARTIAL_CONTEXT_WINDOW, selectedProactivity.partialContextWindow);
const FINAL_CONTEXT_WINDOW = parseIntegerLike(process.env.FINAL_CONTEXT_WINDOW, selectedProactivity.finalContextWindow);
const meetingStartByBot = new Map(); // bot_id -> epoch ms when recording started
const relativeEpochBaseByBot = new Map(); // bot_id -> epoch ms at relative timestamp zero (fallback estimator)
const meetingSessionByBotId = new Map(); // bot_id -> canvas session id
const routeTargetByBotId = new Map(); // bot_id -> { channel, to }
const lastCanvasLineBySession = new Map(); // session id -> last line to dedupe
const botSessionLookupInFlight = new Map(); // bot_id -> Promise<string|null>
const copilotNameBySessionId = new Map(); // session id -> display name
const teamAgentBySessionId = new Map(); // session id -> boolean
const audienceBySessionId = new Map(); // session id -> private|shared
const modeBySessionId = new Map(); // session id -> mode name
const ownerBindingBySessionId = new Map(); // session id -> owner identity tuple
const revealGrantBySessionId = new Map(); // session id -> { category, remaining, granted_at }
let activeMeetingSessionId = 'default';
let activeRouteTarget = null;
let bridgeStatePersistPending = false;

function normalizeRouteChannel(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[a-z0-9_.:-]+$/.test(normalized)) return null;
  return normalized;
}

function normalizeRouteTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const channel = normalizeRouteChannel(raw.channel || raw.channelId);
  const candidates = [raw.to, raw.conversationId, raw.chatId, raw.from];
  const to = candidates
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find((value) => Boolean(value));
  const accountId = typeof raw.accountId === 'string' ? raw.accountId.trim() : '';
  const threadValue = raw.messageThreadId;
  const messageThreadId =
    typeof threadValue === 'number' && Number.isFinite(threadValue)
      ? Math.round(threadValue)
      : (typeof threadValue === 'string' && /^\d+$/.test(threadValue.trim())
          ? Number(threadValue.trim())
          : null);
  if (!channel || !to) return null;
  const normalized = { channel, to };
  if (accountId) normalized.accountId = accountId;
  if (Number.isFinite(messageThreadId)) normalized.messageThreadId = messageThreadId;
  return normalized;
}

function normalizeOwnerBinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const channel = normalizeRouteChannel(raw.channel || raw.channelId);
  const to = [raw.to, raw.conversationId, raw.chatId, raw.from]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find((value) => Boolean(value));
  if (!channel || !to) return null;
  const normalized = { channel, to };
  const accountId = typeof raw.accountId === 'string' ? raw.accountId.trim() : '';
  if (accountId) normalized.accountId = accountId;
  const senderId = typeof raw.senderId === 'string' ? raw.senderId.trim() : '';
  if (senderId) normalized.senderId = senderId;
  return normalized;
}

function ownerBindingMatches(expected, received) {
  const left = normalizeOwnerBinding(expected);
  const right = normalizeOwnerBinding(received);
  if (!left || !right) return false;
  if (left.channel !== right.channel) return false;
  if (left.to !== right.to) return false;
  if ((left.accountId || '') !== (right.accountId || '')) return false;
  if (left.senderId) {
    return left.senderId === (right.senderId || '');
  }
  return true;
}

function normalizeRevealCategory(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ALLOWED_REVEAL_CATEGORIES.has(normalized) ? normalized : '';
}

function getAvailableModes() {
  const modes = promptManager.getAvailableModes();
  if (!modes.includes(FALLBACK_MODE)) modes.push(FALLBACK_MODE);
  return modes;
}

function resolveModeOrDefault(value) {
  const requested = normalizeMode(value);
  const availableModes = getAvailableModes();
  if (availableModes.includes(requested)) return requested;
  const fromPrompt = normalizeMode(promptManager.getDefaultMode());
  if (availableModes.includes(fromPrompt)) return fromPrompt;
  return FALLBACK_MODE;
}

function resolveAudienceOrDefault(value) {
  const normalized = normalizeAudience(value);
  return normalized === 'shared' ? 'shared' : FALLBACK_AUDIENCE;
}

function normalizeSessionInput(value) {
  return normalizeMeetingSessionId(value || activeMeetingSessionId);
}

function getSessionMode(sessionId) {
  const normalized = normalizeSessionInput(sessionId);
  const current = modeBySessionId.get(normalized);
  return resolveModeOrDefault(current);
}

function getSessionAudience(sessionId) {
  const normalized = normalizeSessionInput(sessionId);
  const current = audienceBySessionId.get(normalized);
  return resolveAudienceOrDefault(current);
}

function ensureSessionDefaults(sessionId) {
  const normalized = normalizeSessionInput(sessionId);
  if (!modeBySessionId.has(normalized)) {
    modeBySessionId.set(normalized, resolveModeOrDefault(promptManager.getDefaultMode()));
  }
  if (!audienceBySessionId.has(normalized)) {
    audienceBySessionId.set(normalized, FALLBACK_AUDIENCE);
  }
  return normalized;
}

function setSessionMode(sessionId, mode, reason = 'manual') {
  const normalized = ensureSessionDefaults(sessionId);
  const nextMode = resolveModeOrDefault(mode);
  modeBySessionId.set(normalized, nextMode);
  persistBridgeState(`mode:${reason}`);
  return {
    session: normalized,
    mode: nextMode,
    default_mode: resolveModeOrDefault(promptManager.getDefaultMode()),
    available_modes: getAvailableModes()
  };
}

function setSessionAudience(sessionId, audience, reason = 'manual') {
  const normalized = ensureSessionDefaults(sessionId);
  const nextAudience = resolveAudienceOrDefault(audience);
  audienceBySessionId.set(normalized, nextAudience);
  persistBridgeState(`audience:${reason}`);
  return {
    session: normalized,
    audience: nextAudience
  };
}

function setSessionCopilotName(sessionId, name) {
  const normalized = ensureSessionDefaults(sessionId);
  const clean = normalizeName(name, '');
  if (!clean) return;
  copilotNameBySessionId.set(normalized, clean);
  persistBridgeState('copilot_name');
}

function getSessionCopilotName(sessionId) {
  const normalized = normalizeSessionInput(sessionId);
  return normalizeName(copilotNameBySessionId.get(normalized), 'OpenClaw');
}

function setSessionTeamAgent(sessionId, teamAgent) {
  const normalized = ensureSessionDefaults(sessionId);
  teamAgentBySessionId.set(normalized, Boolean(teamAgent));
  persistBridgeState('team_agent');
}

function getSessionTeamAgent(sessionId) {
  const normalized = normalizeSessionInput(sessionId);
  return Boolean(teamAgentBySessionId.get(normalized));
}

function setSessionOwnerBinding(sessionId, ownerBinding) {
  const normalized = ensureSessionDefaults(sessionId);
  const parsed = normalizeOwnerBinding(ownerBinding);
  if (!parsed) return;
  ownerBindingBySessionId.set(normalized, parsed);
  persistBridgeState('owner_binding');
}

function getSessionOwnerBinding(sessionId) {
  const normalized = normalizeSessionInput(sessionId);
  return ownerBindingBySessionId.get(normalized) || null;
}

function setSessionRevealGrant(sessionId, category) {
  const normalized = ensureSessionDefaults(sessionId);
  const cleanCategory = normalizeRevealCategory(category);
  if (!cleanCategory) return null;
  const grant = {
    category: cleanCategory,
    remaining: 1,
    granted_at: new Date().toISOString()
  };
  revealGrantBySessionId.set(normalized, grant);
  persistBridgeState('reveal_grant');
  return grant;
}

function getSessionRevealGrant(sessionId) {
  const normalized = normalizeSessionInput(sessionId);
  const grant = revealGrantBySessionId.get(normalized);
  if (!grant) return null;
  const remaining = Number(grant.remaining || 0);
  if (remaining <= 0) return null;
  return { ...grant, remaining };
}

function consumeSessionRevealGrant(sessionId) {
  const normalized = normalizeSessionInput(sessionId);
  const grant = revealGrantBySessionId.get(normalized);
  if (!grant) return;
  const remaining = Math.max(0, Number(grant.remaining || 0) - 1);
  if (remaining <= 0) {
    revealGrantBySessionId.delete(normalized);
  } else {
    revealGrantBySessionId.set(normalized, { ...grant, remaining });
  }
  persistBridgeState('reveal_consume');
}

function buildRevealBlock(sessionId) {
  const grant = getSessionRevealGrant(sessionId);
  if (!grant) {
    return '';
  }
  return [
    `Owner approved one-time reveal grant for category: ${grant.category}.`,
    'You may include only minimal details for this single response.',
    'After this response, return to normal privacy restrictions.'
  ].join('\n');
}

function buildPromptInput(sessionId, meetingContext) {
  const normalized = ensureSessionDefaults(sessionId);
  return {
    copilotName: getSessionCopilotName(normalized),
    meetingContext,
    mode: getSessionMode(normalized),
    audience: getSessionAudience(normalized),
    teamAgent: getSessionTeamAgent(normalized),
    revealBlock: buildRevealBlock(normalized)
  };
}

function looksLikePrivateRecall(text) {
  const normalized = String(text || '').toLowerCase();
  if (!normalized) return false;
  return /\b(previous call|last week|last month|last quarter|you mentioned before|from your past|personal note|private)\b/.test(normalized);
}

function applyPrivacyOutputGuard(text, sessionId) {
  const normalizedSession = ensureSessionDefaults(sessionId);
  const audience = getSessionAudience(normalizedSession);
  if (audience !== 'shared') {
    return { blocked: false, text };
  }
  if (getSessionRevealGrant(normalizedSession)) {
    return { blocked: false, text };
  }
  if (!looksLikePrivateRecall(text)) {
    return { blocked: false, text };
  }
  return {
    blocked: true,
    text:
      '**Privacy guard:** Shared mode is active. I can use transcript + open web only. Owner can run `/clawpilot reveal <category>` for one-time private recall.'
  };
}

function buildMeetingStartMessage(sessionId) {
  const normalized = ensureSessionDefaults(sessionId);
  const template = getMeetingStartPromptTemplate();
  const rendered = template
    .replaceAll('{{COPILOT_NAME}}', getSessionCopilotName(normalized))
    .replaceAll('{{ACTIVE_MODE}}', getSessionMode(normalized))
    .replaceAll('{{ACTIVE_AUDIENCE}}', getSessionAudience(normalized))
    .trim();
  return rendered || DEFAULT_MEETING_START_PROMPT;
}

async function announceMeetingState(botId, sessionId) {
  const message = buildMeetingStartMessage(sessionId);
  await sendVerboseMirrorToOpenClaw(message, { botId });
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractAudienceIntent(text) {
  const normalized = normalizeControlText(text);
  if (!normalized) return null;

  const hasAudienceCue = /\b(audience|privacy|visibility)\b/.test(normalized);
  const hasChangeCue = /\b(set|switch|change|make|move|use|keep|update|stay)\b/.test(normalized);
  if (!hasAudienceCue && !hasChangeCue) return null;

  const wantsPrivate = /\b(private|personal|owner only|owner-only)\b/.test(normalized);
  const wantsShared = /\b(shared|public|team)\b/.test(normalized);
  if (wantsPrivate && wantsShared) return null;
  if (wantsPrivate) return 'private';
  if (wantsShared) return 'shared';
  return null;
}

function extractModeIntent(text, availableModes = getAvailableModes()) {
  const normalized = normalizeControlText(text);
  const modes = Array.from(
    new Set(
      (Array.isArray(availableModes) ? availableModes : [])
        .map((value) => normalizeMode(value))
        .filter(Boolean)
    )
  );
  if (!normalized || modes.length === 0) {
    return { mode: null, invalidMode: '' };
  }

  const explicitMatch = normalized.match(/\bmode\b\s*(?:is|to|as)?\s*([a-z0-9_-]+)/);
  if (explicitMatch?.[1]) {
    const candidate = normalizeMode(explicitMatch[1]);
    if (modes.includes(candidate)) {
      return { mode: candidate, invalidMode: '' };
    }
    return { mode: null, invalidMode: candidate };
  }

  const mentioned = modes.filter((mode) => {
    const pattern = new RegExp(`\\b${escapeRegex(mode)}\\b`, 'i');
    return pattern.test(normalized);
  });
  if (mentioned.length !== 1) {
    return { mode: null, invalidMode: '' };
  }

  const hasModeCue = /\bmode\b/.test(normalized);
  const hasChangeCue = /\b(set|switch|change|use|run|move|go|try|enter|let s|lets)\b/.test(normalized);
  if (!hasModeCue && !hasChangeCue) {
    return { mode: null, invalidMode: '' };
  }
  return { mode: mentioned[0], invalidMode: '' };
}

function extractStartupIntent(text, availableModes = getAvailableModes()) {
  const audience = extractAudienceIntent(text);
  const modeIntent = extractModeIntent(text, availableModes);
  return {
    audience,
    mode: modeIntent.mode,
    invalidMode: modeIntent.invalidMode
  };
}

function persistBridgeState(reason = 'update') {
  if (!BRIDGE_STATE_FILE) return;
  if (bridgeStatePersistPending) return;
  bridgeStatePersistPending = true;
  setTimeout(() => {
    bridgeStatePersistPending = false;
    const payload = {
      updated_at: new Date().toISOString(),
      reason,
      active_meeting_session_id: activeMeetingSessionId,
      active_route_target: activeRouteTarget,
      meeting_sessions: Array.from(meetingSessionByBotId.entries()).map(([botId, sessionId]) => ({
        bot_id: botId,
        meeting_session: sessionId
      })),
      route_targets: Array.from(routeTargetByBotId.entries()).map(([botId, routeTarget]) => ({
        bot_id: botId,
        route_target: routeTarget
      })),
      session_modes: Array.from(modeBySessionId.entries()).map(([session, mode]) => ({
        session,
        mode
      })),
      session_audiences: Array.from(audienceBySessionId.entries()).map(([session, audience]) => ({
        session,
        audience
      })),
      session_copilot_names: Array.from(copilotNameBySessionId.entries()).map(([session, copilot_name]) => ({
        session,
        copilot_name
      })),
      session_team_agents: Array.from(teamAgentBySessionId.entries()).map(([session, team_agent]) => ({
        session,
        team_agent: Boolean(team_agent)
      })),
      session_owner_bindings: Array.from(ownerBindingBySessionId.entries()).map(([session, owner_binding]) => ({
        session,
        owner_binding
      })),
      session_reveal_grants: Array.from(revealGrantBySessionId.entries()).map(([session, grant]) => ({
        session,
        grant
      }))
    };
    try {
      fs.writeFileSync(BRIDGE_STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (error) {
      console.warn(`[BridgeState] persist failed file=${BRIDGE_STATE_FILE} error=${error.message}`);
    }
  }, 10);
}

function loadBridgeState() {
  if (!BRIDGE_STATE_FILE) return;
  if (!fs.existsSync(BRIDGE_STATE_FILE)) return;
  try {
    const raw = fs.readFileSync(BRIDGE_STATE_FILE, 'utf8');
    const parsed = safeParseJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    meetingSessionByBotId.clear();
    routeTargetByBotId.clear();
    modeBySessionId.clear();
    audienceBySessionId.clear();
    copilotNameBySessionId.clear();
    teamAgentBySessionId.clear();
    ownerBindingBySessionId.clear();
    revealGrantBySessionId.clear();

    const meetingEntries = Array.isArray(parsed.meeting_sessions) ? parsed.meeting_sessions : [];
    for (const entry of meetingEntries) {
      const botId = typeof entry?.bot_id === 'string' ? entry.bot_id.trim() : '';
      const sessionId = normalizeMeetingSessionId(entry?.meeting_session);
      if (!botId || !sessionId) continue;
      meetingSessionByBotId.set(botId, sessionId);
    }

    const routeEntries = Array.isArray(parsed.route_targets) ? parsed.route_targets : [];
    for (const entry of routeEntries) {
      const botId = typeof entry?.bot_id === 'string' ? entry.bot_id.trim() : '';
      const routeTarget = normalizeRouteTarget(entry?.route_target);
      if (!botId || !routeTarget) continue;
      routeTargetByBotId.set(botId, routeTarget);
    }

    const modeEntries = Array.isArray(parsed.session_modes) ? parsed.session_modes : [];
    for (const entry of modeEntries) {
      const session = normalizeMeetingSessionId(entry?.session);
      const mode = resolveModeOrDefault(entry?.mode);
      if (!session || !mode) continue;
      modeBySessionId.set(session, mode);
    }

    const audienceEntries = Array.isArray(parsed.session_audiences) ? parsed.session_audiences : [];
    for (const entry of audienceEntries) {
      const session = normalizeMeetingSessionId(entry?.session);
      const audience = resolveAudienceOrDefault(entry?.audience);
      if (!session || !audience) continue;
      audienceBySessionId.set(session, audience);
    }

    const copilotEntries = Array.isArray(parsed.session_copilot_names) ? parsed.session_copilot_names : [];
    for (const entry of copilotEntries) {
      const session = normalizeMeetingSessionId(entry?.session);
      const copilotName = normalizeName(entry?.copilot_name, '');
      if (!session || !copilotName) continue;
      copilotNameBySessionId.set(session, copilotName);
    }

    const teamEntries = Array.isArray(parsed.session_team_agents) ? parsed.session_team_agents : [];
    for (const entry of teamEntries) {
      const session = normalizeMeetingSessionId(entry?.session);
      if (!session) continue;
      teamAgentBySessionId.set(session, Boolean(entry?.team_agent));
    }

    const ownerEntries = Array.isArray(parsed.session_owner_bindings) ? parsed.session_owner_bindings : [];
    for (const entry of ownerEntries) {
      const session = normalizeMeetingSessionId(entry?.session);
      const ownerBinding = normalizeOwnerBinding(entry?.owner_binding);
      if (!session || !ownerBinding) continue;
      ownerBindingBySessionId.set(session, ownerBinding);
    }

    const revealEntries = Array.isArray(parsed.session_reveal_grants) ? parsed.session_reveal_grants : [];
    for (const entry of revealEntries) {
      const session = normalizeMeetingSessionId(entry?.session);
      const category = normalizeRevealCategory(entry?.grant?.category);
      const remaining = Number(entry?.grant?.remaining || 0);
      if (!session || !category || remaining <= 0) continue;
      revealGrantBySessionId.set(session, {
        category,
        remaining: Math.max(1, Math.round(remaining)),
        granted_at: typeof entry?.grant?.granted_at === 'string' ? entry.grant.granted_at : new Date().toISOString()
      });
    }

    const explicitRouteTarget = normalizeRouteTarget(parsed.active_route_target);
    if (explicitRouteTarget) {
      activeRouteTarget = explicitRouteTarget;
    } else {
      activeRouteTarget = Array.from(routeTargetByBotId.values()).at(-1) || null;
    }

    const explicitSessionId = normalizeMeetingSessionId(parsed.active_meeting_session_id || '');
    if (explicitSessionId !== 'default') {
      activeMeetingSessionId = explicitSessionId;
    } else {
      activeMeetingSessionId = Array.from(meetingSessionByBotId.values()).at(-1) || 'default';
    }
    ensureSessionDefaults(activeMeetingSessionId);

    console.log(
      `[BridgeState] loaded file=${BRIDGE_STATE_FILE} sessions=${meetingSessionByBotId.size} routes=${routeTargetByBotId.size} modes=${modeBySessionId.size} audiences=${audienceBySessionId.size}`
    );
  } catch (error) {
    console.warn(`[BridgeState] load failed file=${BRIDGE_STATE_FILE} error=${error.message}`);
  }
}

function rememberBotRouteTarget(botId, routeTarget) {
  if (!botId) return;
  const normalized = normalizeRouteTarget(routeTarget);
  if (!normalized) return;
  routeTargetByBotId.set(botId, normalized);
  activeRouteTarget = normalized;
  persistBridgeState('remember_route_target');
}

function resolveRouteTarget(routeTarget, botId = null) {
  const explicit = normalizeRouteTarget(routeTarget);
  if (explicit) return explicit;
  if (botId && routeTargetByBotId.has(botId)) {
    return routeTargetByBotId.get(botId);
  }
  return activeRouteTarget;
}

function normalizeControlText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\w/\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function setMuteState(nextMuted, reason = 'manual') {
  IS_MUTED = Boolean(nextMuted);
  if (IS_MUTED) {
    DEBUG_MODE = false;
    queuedReaction = null;
    if (queuedReactionTimer) {
      clearTimeout(queuedReactionTimer);
      queuedReactionTimer = null;
    }
  }
  console.log(`[${IS_MUTED ? 'MUTED' : 'UNMUTED'}] Transcript processing ${IS_MUTED ? 'paused' : 'resumed'} reason=${reason}`);
  return { muted: IS_MUTED, meetverbose: DEBUG_MODE };
}

function setMeetVerboseState(nextEnabled, reason = 'manual') {
  DEBUG_MODE = Boolean(nextEnabled);
  console.log(`[MEETVERBOSE ${DEBUG_MODE ? 'ON' : 'OFF'}] Raw transcripts ${DEBUG_MODE ? 'enabled' : 'disabled'} reason=${reason}`);
  return { muted: IS_MUTED, meetverbose: DEBUG_MODE };
}

function parseTranscriptControlCommand(speaker, text) {
  if (CONTROL_SPEAKER_REGEX) {
    try {
      if (!new RegExp(CONTROL_SPEAKER_REGEX, 'i').test(String(speaker || ''))) return null;
    } catch (err) {
      // Invalid regex should not break transcript processing.
      console.warn('[Control] Invalid CONTROL_SPEAKER_REGEX:', err.message);
      return null;
    }
  }
  const normalized = normalizeControlText(text);
  if (!normalized) return null;
  const words = normalized.split(' ');
  if (words.length > 4) return null;

  if (['/mute', 'mute', 'stop transcribing', 'stop transcription', 'stop transcript'].includes(normalized)) {
    return { type: 'mute', ack: 'Muted meeting copilot. I will not process transcripts until unmuted.' };
  }
  if (['/unmute', 'unmute', 'resume transcribing', 'resume transcription', 'start transcribing'].includes(normalized)) {
    return { type: 'unmute', ack: 'Unmuted meeting copilot. I am processing transcripts again.' };
  }
  if (['/meetverbose on', 'meetverbose on', 'verbose on', 'transcript debug on'].includes(normalized)) {
    return { type: 'meetverbose_on', ack: 'Transcript debug is ON. Final transcript lines will be mirrored to the active chat channel.' };
  }
  if (['/meetverbose off', 'meetverbose off', 'verbose off', 'transcript debug off'].includes(normalized)) {
    return { type: 'meetverbose_off', ack: 'Transcript debug is OFF. I will send only copilot guidance.' };
  }
  return null;
}

function hasHighValueCue(text) {
  const normalized = normalizeControlText(text);
  if (!normalized) return false;
  return /\b(what should i|should i|i dont know|i don't know|stuck|low energy|problem|issue|objection|decision|next step|what do i do|help me)\b/.test(normalized);
}

app.use(express.json());

function getBearerTokenFromHeader(rawHeader) {
  if (!rawHeader || typeof rawHeader !== 'string') return '';
  const [scheme, token] = rawHeader.trim().split(/\s+/, 2);
  if (!scheme || !token) return '';
  if (scheme.toLowerCase() !== 'bearer') return '';
  return token.trim();
}

function safeTokenEquals(left, right) {
  if (!left || !right) return false;
  const leftBuf = Buffer.from(String(left));
  const rightBuf = Buffer.from(String(right));
  if (leftBuf.length !== rightBuf.length) return false;
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function requireBridgeAuth(req, res, next) {
  if (!BRIDGE_AUTH_ENABLED) return next();
  const headerValue = req.get('authorization') || '';
  const token = getBearerTokenFromHeader(headerValue);
  if (!safeTokenEquals(token, BRIDGE_API_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function sanitizeMeetingUrlValue(value) {
  if (value && typeof value === 'object') {
    const platform = typeof value.platform === 'string' ? value.platform.trim() : '';
    const meetingId = typeof value.meeting_id === 'string' ? value.meeting_id.trim() : '';
    const out = {};
    if (platform) out.platform = platform;
    if (meetingId) out.meeting_id = meetingId;
    if (Object.keys(out).length > 0) return out;
  }

  if (typeof value === 'string' && value.trim()) {
    return extractMeetingTarget(value) || null;
  }

  return null;
}

function firstNonEmptyString(...candidates) {
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function buildSafeLaunchResponse(raw = {}, fallback = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const safe = {};

  const id = firstNonEmptyString(source.id, base.id);
  if (id) safe.id = id;

  const status = firstNonEmptyString(source.status, base.status);
  if (status) safe.status = status;

  const botName = firstNonEmptyString(source.bot_name, base.bot_name);
  if (botName) safe.bot_name = botName;

  const meetingUrl = sanitizeMeetingUrlValue(source.meeting_url ?? base.meeting_url);
  if (meetingUrl) safe.meeting_url = meetingUrl;

  const joinAt = firstNonEmptyString(source.join_at, base.join_at);
  if (joinAt) safe.join_at = joinAt;

  const meetingSession = firstNonEmptyString(source.meeting_session, base.meeting_session);
  if (meetingSession) safe.meeting_session = meetingSession;

  const routeTarget = normalizeRouteTarget(source.routing_target) || normalizeRouteTarget(base.routing_target);
  if (routeTarget || Object.prototype.hasOwnProperty.call(source, 'routing_target') || Object.prototype.hasOwnProperty.call(base, 'routing_target')) {
    safe.routing_target = routeTarget || null;
  }

  const replacedFrom = firstNonEmptyString(source.replaced_from_bot_id, base.replaced_from_bot_id);
  if (replacedFrom) safe.replaced_from_bot_id = replacedFrom;

  const error = firstNonEmptyString(source.error, base.error);
  if (error) safe.error = error;

  const code = firstNonEmptyString(source.code, base.code);
  if (code) safe.code = code;

  return safe;
}

// Health check
app.get('/health', (req, res) => {
  const session = ensureSessionDefaults(activeMeetingSessionId);
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    muted: IS_MUTED,
    meetverbose: DEBUG_MODE,
    session,
    mode: getSessionMode(session),
    audience: getSessionAudience(session),
    copilot_name: getSessionCopilotName(session),
    proactivity: PROACTIVITY_LEVEL,
    prompt: {
      path: promptManager.getPromptPath(),
      available_modes: getAvailableModes(),
      default_mode: resolveModeOrDefault(promptManager.getDefaultMode())
    },
    hook: {
      url: OPENCLAW_HOOK_URL,
      agent_url: OPENCLAW_AGENT_HOOK_URL,
      token_set: Boolean(OPENCLAW_HOOK_TOKEN),
      url_source: OPENCLAW_HOOK_URL_SOURCE,
      token_source: OPENCLAW_HOOK_TOKEN_SOURCE
    },
    discord: {
      direct_delivery: DISCORD_DIRECT_DELIVERY,
      token_set: Boolean(DISCORD_BOT_TOKEN),
      token_source: DISCORD_BOT_TOKEN_SOURCE
    },
    direct_delivery_adapters: getDirectDeliveryStatus(),
    telegram: {
      token_set: Boolean(TELEGRAM_BOT_TOKEN),
      token_source: TELEGRAM_BOT_TOKEN_SOURCE
    }
  });
});

// Mute/unmute endpoints
app.post('/mute', requireBridgeAuth, (req, res) => {
  const state = setMuteState(true, 'http:/mute');
  res.json({ ...state, message: 'Transcript processing paused' });
});

app.post('/unmute', requireBridgeAuth, (req, res) => {
  const state = setMuteState(false, 'http:/unmute');
  res.json({ ...state, message: 'Transcript processing resumed' });
});

app.get('/mute-status', (req, res) => {
  res.json({ muted: IS_MUTED });
});

app.get('/copilot/status', requireBridgeAuth, (req, res) => {
  const session = ensureSessionDefaults(getMeetingSessionId(req));
  const revealGrant = getSessionRevealGrant(session);
  res.json({
    session,
    muted: IS_MUTED,
    meetverbose: DEBUG_MODE,
    mode: getSessionMode(session),
    audience: getSessionAudience(session),
    copilot_name: getSessionCopilotName(session),
    team_agent: getSessionTeamAgent(session),
    owner_bound: Boolean(getSessionOwnerBinding(session)),
    reveal_grant: revealGrant || null,
    reaction_in_flight: reactionInFlight,
    queued_reaction: Boolean(queuedReaction),
    transcript_segments_buffered: transcriptBuffer.length,
    thresholds: {
      proactivity: PROACTIVITY_LEVEL,
      reaction_cooldown_ms: REACTION_COOLDOWN_MS,
      partial_reaction_debounce_ms: PARTIAL_REACTION_DEBOUNCE_MS,
      min_new_words: MIN_NEW_WORDS,
      partial_min_new_words: PARTIAL_MIN_NEW_WORDS,
      final_context_window: FINAL_CONTEXT_WINDOW,
      partial_context_window: PARTIAL_CONTEXT_WINDOW
    },
    hook: {
      url: OPENCLAW_HOOK_URL,
      agent_url: OPENCLAW_AGENT_HOOK_URL,
      token_set: Boolean(OPENCLAW_HOOK_TOKEN),
      url_source: OPENCLAW_HOOK_URL_SOURCE,
      token_source: OPENCLAW_HOOK_TOKEN_SOURCE
    },
    discord: {
      direct_delivery: DISCORD_DIRECT_DELIVERY,
      token_set: Boolean(DISCORD_BOT_TOKEN),
      token_source: DISCORD_BOT_TOKEN_SOURCE
    },
    direct_delivery_adapters: getDirectDeliveryStatus(),
    telegram: {
      token_set: Boolean(TELEGRAM_BOT_TOKEN),
      token_source: TELEGRAM_BOT_TOKEN_SOURCE
    },
    prompt: {
      path: promptManager.getPromptPath(),
      available_modes: getAvailableModes(),
      default_mode: resolveModeOrDefault(promptManager.getDefaultMode())
    }
  });
});

function buildPrivacyResponse(sessionId) {
  const session = ensureSessionDefaults(sessionId);
  return {
    session,
    audience: getSessionAudience(session),
    team_agent: getSessionTeamAgent(session),
    owner_bound: Boolean(getSessionOwnerBinding(session)),
    reveal_grant: getSessionRevealGrant(session) || null
  };
}

app.get('/copilot/mode', requireBridgeAuth, (req, res) => {
  const session = ensureSessionDefaults(getMeetingSessionId(req));
  res.json({
    session,
    mode: getSessionMode(session),
    default_mode: resolveModeOrDefault(promptManager.getDefaultMode()),
    available_modes: getAvailableModes()
  });
});

app.post('/copilot/mode', requireBridgeAuth, (req, res) => {
  const session = ensureSessionDefaults(getMeetingSessionId(req));
  const requestedMode = normalizeMode(req.body?.mode);
  if (!getAvailableModes().includes(requestedMode)) {
    return res.status(400).json({
      error: 'invalid mode',
      available_modes: getAvailableModes()
    });
  }
  const result = setSessionMode(session, requestedMode, 'http:/copilot/mode');
  res.json(result);
});

app.get('/copilot/privacy', requireBridgeAuth, (req, res) => {
  const session = ensureSessionDefaults(getMeetingSessionId(req));
  res.json(buildPrivacyResponse(session));
});

app.post('/copilot/audience', requireBridgeAuth, (req, res) => {
  const session = ensureSessionDefaults(getMeetingSessionId(req));
  const requestedAudienceRaw = String(req.body?.audience || '').trim().toLowerCase();
  const requestedAudience =
    requestedAudienceRaw === 'shared'
      ? 'shared'
      : (requestedAudienceRaw === 'private' ? 'private' : '');
  if (!['private', 'shared'].includes(requestedAudience)) {
    return res.status(400).json({ error: 'invalid audience (expected private|shared)' });
  }
  setSessionAudience(session, requestedAudience, 'http:/copilot/audience');
  res.json(buildPrivacyResponse(session));
});

app.post('/copilot/startup-input', requireBridgeAuth, async (req, res) => {
  const session = ensureSessionDefaults(getMeetingSessionId(req));
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const routeTarget = normalizeRouteTarget(req.body?.route_target);
  const requester = normalizeOwnerBinding(req.body?.owner_binding);
  const availableModes = getAvailableModes();
  const current = {
    audience: getSessionAudience(session),
    mode: getSessionMode(session)
  };

  if (!text) {
    return res.status(400).json({ error: 'text required', session, current });
  }

  const intent = extractStartupIntent(text, availableModes);
  const hasIntent = Boolean(intent.audience || intent.mode);
  if (!hasIntent) {
    const message = intent.invalidMode
      ? `Mode "${intent.invalidMode}" is not available.`
      : 'No audience/mode preference detected.';
    return res.json({
      session,
      matched: false,
      authorized: true,
      updates: {},
      current,
      message,
      ...(intent.invalidMode
        ? { invalid_mode: intent.invalidMode, available_modes: availableModes }
        : {})
    });
  }

  const expectedOwner = getSessionOwnerBinding(session);
  if (!expectedOwner) {
    return res.json({
      session,
      matched: true,
      authorized: false,
      updates: {},
      current,
      message: 'Owner authorization required: no owner binding set for this session.'
    });
  }
  if (!ownerBindingMatches(expectedOwner, requester)) {
    return res.json({
      session,
      matched: true,
      authorized: false,
      updates: {},
      current,
      message: 'Owner authorization required for text setup updates.'
    });
  }

  const updates = {};
  if (intent.audience) {
    setSessionAudience(session, intent.audience, 'http:/copilot/startup-input');
    updates.audience = intent.audience;
  }
  if (intent.mode) {
    setSessionMode(session, intent.mode, 'http:/copilot/startup-input');
    updates.mode = intent.mode;
  }
  const next = {
    audience: getSessionAudience(session),
    mode: getSessionMode(session)
  };

  const changeSummary = [];
  if (updates.audience) changeSummary.push(`audience=${updates.audience}`);
  if (updates.mode) changeSummary.push(`mode=${updates.mode}`);
  let message = changeSummary.length
    ? `Updated ${changeSummary.join(', ')}.`
    : 'No changes applied.';

  if (routeTarget && changeSummary.length) {
    await sendVerboseMirrorToOpenClaw(`[MEETING CONTROL] ${message}`, {
      routeTarget,
      sessionId: session
    });
  }

  if (intent.invalidMode && !updates.mode) {
    message = `${message} Mode "${intent.invalidMode}" is not available.`;
  }

  return res.json({
    session,
    matched: true,
    authorized: true,
    updates,
    current: next,
    message,
    ...(intent.invalidMode && !updates.mode
      ? { invalid_mode: intent.invalidMode, available_modes: availableModes }
      : {})
  });
});

app.post('/copilot/reveal', requireBridgeAuth, (req, res) => {
  const session = ensureSessionDefaults(getMeetingSessionId(req));
  const category = normalizeRevealCategory(req.body?.category);
  if (!category) {
    return res.status(400).json({
      error: 'invalid category',
      allowed_categories: Array.from(ALLOWED_REVEAL_CATEGORIES)
    });
  }
  const ownerBinding = getSessionOwnerBinding(session);
  if (!ownerBinding) {
    return res.status(409).json({ error: 'owner binding not set for this session' });
  }
  const requester = normalizeOwnerBinding(req.body?.owner_binding);
  if (!ownerBindingMatches(ownerBinding, requester)) {
    return res.status(403).json({ error: 'owner authorization required' });
  }
  setSessionRevealGrant(session, category);
  res.json(buildPrivacyResponse(session));
});

function extractMeetingTarget(meetingUrl) {
  if (typeof meetingUrl !== 'string' || !meetingUrl) {
    return null;
  }
  const trimmed = meetingUrl.trim();
  const meet = trimmed.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  if (meet) {
    return { platform: 'google_meet', meeting_id: meet[1].toLowerCase() };
  }
  const zoom = trimmed.match(/(?:[a-z0-9-]+\.)?zoom\.us\/j\/([0-9]+)/i);
  if (zoom) {
    return { platform: 'zoom', meeting_id: zoom[1] };
  }
  return null;
}

function normalizeMeetingSessionId(value) {
  if (!value) {
    return 'default';
  }
  if (typeof meeting !== 'undefined' && meeting?.resolveSessionId) {
    return meeting.resolveSessionId(value);
  }
  const raw = String(value).trim();
  return raw ? raw.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120) || 'default' : 'default';
}

loadBridgeState();

function extractSessionFromMeetingValue(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    const target = extractMeetingTarget(value);
    return target?.meeting_id ? normalizeMeetingSessionId(target.meeting_id) : null;
  }
  if (typeof value === 'object') {
    if (typeof value.meeting_id === 'string' && value.meeting_id.trim()) {
      return normalizeMeetingSessionId(value.meeting_id);
    }
    if (typeof value.url === 'string' && value.url.trim()) {
      const target = extractMeetingTarget(value.url);
      return target?.meeting_id ? normalizeMeetingSessionId(target.meeting_id) : null;
    }
  }
  return null;
}

function resolveSessionFromEvent(event, botId = null) {
  if (botId && meetingSessionByBotId.has(botId)) {
    return meetingSessionByBotId.get(botId);
  }

  const candidates = [
    event?.data?.bot?.meeting_url,
    event?.data?.meeting_url,
    event?.data?.data?.meeting_url,
    event?.meeting_url
  ];
  for (const candidate of candidates) {
    const sessionId = extractSessionFromMeetingValue(candidate);
    if (sessionId) {
      return sessionId;
    }
  }

  return null;
}

function rememberBotSession(botId, sessionId) {
  if (!botId || !sessionId) {
    return;
  }
  const normalized = normalizeMeetingSessionId(sessionId);
  meetingSessionByBotId.set(botId, normalized);
  activeMeetingSessionId = normalized;
  ensureSessionDefaults(normalized);
  persistBridgeState('remember_session');
}

function forgetBotSession(botId) {
  if (!botId) {
    return;
  }
  const removed = meetingSessionByBotId.delete(botId);
  routeTargetByBotId.delete(botId);
  if (routeTargetByBotId.size === 0) {
    activeRouteTarget = null;
  } else {
    activeRouteTarget = Array.from(routeTargetByBotId.values()).at(-1) || null;
  }
  if (!removed) {
    persistBridgeState('forget_session_noop');
    return;
  }
  if (meetingSessionByBotId.size === 0) {
    activeMeetingSessionId = 'default';
  } else {
    activeMeetingSessionId = Array.from(meetingSessionByBotId.values()).at(-1) || 'default';
  }
  persistBridgeState('forget_session');
}

async function hydrateBotSessionFromApi(botId) {
  if (!botId || meetingSessionByBotId.has(botId) || !RECALL_API_KEY) {
    return meetingSessionByBotId.get(botId) || null;
  }
  if (botSessionLookupInFlight.has(botId)) {
    return botSessionLookupInFlight.get(botId);
  }

  const lookupPromise = (async () => {
    try {
      const response = await fetch(`${RECALL_BOTS_ENDPOINT}/${botId}`, {
        headers: {
          Authorization: `Token ${RECALL_API_KEY}`
        }
      });
      if (!response.ok) {
        return null;
      }
      const payload = await response.json();
      const sessionId = extractSessionFromMeetingValue(payload?.meeting_url);
      if (sessionId) {
        rememberBotSession(botId, sessionId);
      }
      return sessionId || null;
    } catch {
      return null;
    } finally {
      botSessionLookupInFlight.delete(botId);
    }
  })();

  botSessionLookupInFlight.set(botId, lookupPromise);
  return lookupPromise;
}

function clipCanvasText(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  if (text.length <= MEETING_TRANSCRIPT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, MEETING_TRANSCRIPT_MAX_CHARS - 1)}…`;
}

function appendTranscriptToCanvas(sessionId, speaker, text, botId) {
  if (!MEETING_TRANSCRIPT_TO_CANVAS || typeof meeting === 'undefined') {
    return;
  }

  const normalizedSession = normalizeMeetingSessionId(sessionId || activeMeetingSessionId);
  const lineText = clipCanvasText(`${speaker}: ${text}`);
  if (!lineText) {
    return;
  }
  const dedupeKey = `${normalizedSession}|${lineText}`;
  if (lastCanvasLineBySession.get(normalizedSession) === dedupeKey) {
    return;
  }
  lastCanvasLineBySession.set(normalizedSession, dedupeKey);

  const meta = { source: 'transcript', speaker, bot_id: botId || null };
  meeting.addSection(normalizedSession, 'bullet', lineText, meta);
  if (MEETING_MIRROR_TO_DEFAULT && normalizedSession !== 'default') {
    meeting.addSection('default', 'bullet', lineText, meta);
  }
}

function resetMeetingCanvasForSession(sessionId) {
  if (typeof meeting === 'undefined') {
    return;
  }
  const normalized = normalizeMeetingSessionId(sessionId || activeMeetingSessionId);
  const title = `Live Meeting - ${normalized}`;
  meeting.clearMeeting(normalized);
  meeting.setTitle(normalized, title);
  if (MEETING_MIRROR_TO_DEFAULT && normalized !== 'default') {
    meeting.clearMeeting('default');
    meeting.setTitle('default', title);
  }
}

async function findActiveBotForMeeting(meetingUrl) {
  const target = extractMeetingTarget(meetingUrl);
  if (!target || !RECALL_API_KEY) {
    return null;
  }
  try {
    const response = await fetch(`${RECALL_BOTS_ENDPOINT}/?page_size=100`, {
      headers: {
        Authorization: `Token ${RECALL_API_KEY}`
      }
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const inactiveCodes = new Set(['done', 'fatal', 'call_ended']);
    for (const bot of results) {
      const platform = bot?.meeting_url?.platform;
      const meetingId = bot?.meeting_url?.meeting_id;
      const code = bot?.status_changes?.[bot.status_changes.length - 1]?.code || 'unknown';
      if (platform === target.platform && meetingId === target.meeting_id && !inactiveCodes.has(code)) {
        return { id: bot.id, code, meeting_url: bot.meeting_url };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isTerminalBotCode(code) {
  return code === 'done' || code === 'fatal' || code === 'call_ended';
}

async function getBotStatusCode(botId) {
  try {
    const response = await fetch(`${RECALL_BOTS_ENDPOINT}/${botId}`, {
      headers: {
        Authorization: `Token ${RECALL_API_KEY}`
      }
    });
    if (!response.ok) {
      return 'unknown';
    }
    const payload = await response.json();
    return payload?.status_changes?.[payload.status_changes.length - 1]?.code || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function removeBotFromCall(botId) {
  try {
    const response = await fetch(`${RECALL_BOTS_ENDPOINT}/${botId}/leave_call/`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${RECALL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    const code = body?.code || '';
    if (response.ok) {
      return { ok: true, code: code || 'ok' };
    }
    if (code === 'cannot_command_unstarted_bot' || code === 'cannot_command_completed_bot') {
      return { ok: true, code };
    }
    return { ok: false, code: code || `http_${response.status}`, status: response.status };
  } catch (error) {
    return { ok: false, code: 'request_failed', error: error.message };
  }
}

async function waitForBotTerminal(botId, timeoutMs = BOT_REPLACE_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = await getBotStatusCode(botId);
    if (isTerminalBotCode(code)) {
      return { ok: true, code };
    }
    await new Promise((resolve) => setTimeout(resolve, BOT_REPLACE_POLL_MS));
  }
  return { ok: false, code: 'timeout' };
}

// Proxy endpoint to launch bots (avoids CORS)
app.post('/launch', requireBridgeAuth, async (req, res) => {
  const { meeting_url, language, provider, replace_active, bot_name, agent_name, route_target, owner_binding, team_agent } = req.body;
  
  if (!meeting_url) {
    return res.status(400).json({ error: 'meeting_url required' });
  }
  const requestedRouteTarget = normalizeRouteTarget(route_target);
  const requestedOwnerBinding = normalizeOwnerBinding(owner_binding);
  const requestedTeamAgent = Boolean(parseBooleanLike(team_agent, false));
  const launchSessionId = extractSessionFromMeetingValue(meeting_url) || activeMeetingSessionId;

  const shouldReplaceActive = typeof replace_active === 'boolean'
    ? replace_active
    : REPLACE_ACTIVE_ON_DUPLICATE;
  const existingBot = await findActiveBotForMeeting(meeting_url);
  const existingRouteTarget = existingBot?.id ? routeTargetByBotId.get(existingBot.id) || null : null;
  const effectiveRouteTarget = requestedRouteTarget || existingRouteTarget;
  let replacedFromBotId = null;
  if (existingBot) {
    if (!shouldReplaceActive) {
      return res.status(409).json(buildSafeLaunchResponse({
        id: existingBot.id,
        status: 'already_active',
        meeting_url: existingBot.meeting_url,
        meeting_session: normalizeMeetingSessionId(launchSessionId),
        routing_target: effectiveRouteTarget || null
      }));
    }
    const removal = await removeBotFromCall(existingBot.id);
    if (!removal.ok) {
      return res.status(502).json(buildSafeLaunchResponse({
        id: existingBot.id,
        status: 'replace_failed',
        meeting_url,
        meeting_session: normalizeMeetingSessionId(launchSessionId),
        routing_target: effectiveRouteTarget || null,
        error: 'Failed to replace active bot',
        code: removal.code || 'replace_failed'
      }));
    }
    const waitResult = await waitForBotTerminal(existingBot.id);
    if (!waitResult.ok) {
      return res.status(409).json(buildSafeLaunchResponse({
        id: existingBot.id,
        status: 'replace_timeout',
        meeting_url,
        meeting_session: normalizeMeetingSessionId(launchSessionId),
        routing_target: effectiveRouteTarget || null,
        error: 'Timed out waiting for active bot replacement',
        code: waitResult.code || 'replace_timeout'
      }));
    }
    replacedFromBotId = existingBot.id;
    forgetBotSession(existingBot.id);
  }

  const requestedLang = language || DEFAULT_RECALL_LANGUAGE;
  const lang = requestedLang === 'multi' ? 'auto' : requestedLang;
  const prov = provider || 'recallai_streaming';
  const resolvedBotName = resolveBotName({ requested: bot_name, agentName: agent_name });
  ensureSessionDefaults(launchSessionId);
  setSessionCopilotName(launchSessionId, resolvedBotName);
  setSessionTeamAgent(launchSessionId, requestedTeamAgent);
  if (requestedOwnerBinding) {
    setSessionOwnerBinding(launchSessionId, requestedOwnerBinding);
  }

  // Build provider config (must use exact provider names from Recall API)
  let transcriptConfig;
  if (prov === 'deepgram' || prov === 'deepgram_only') {
    const deepgramLang = requestedLang === 'multi' ? 'en' : requestedLang;
    transcriptConfig = {
      provider: {
        deepgram_streaming: {
          language: deepgramLang,
          model: 'nova-3'
        }
      }
    };
  } else {
    transcriptConfig = {
      provider: {
        recallai_streaming: {
          mode: DEFAULT_RECALL_STT_MODE,
          language_code: lang
        }
      }
    };
  }

  const body = {
    meeting_url,
    bot_name: resolvedBotName,
    recording_config: {
      transcript: transcriptConfig,
      realtime_endpoints: [
        {
          type: 'webhook',
          url: `${WEBHOOK_BASE_URL.replace(/\/$/, '')}/webhook?token=${WEBHOOK_SECRET}`,
          events: ['transcript.data', 'transcript.partial_data']
        }
      ]
    }
  };

  try {
    const response = await fetch(`${RECALL_BOTS_ENDPOINT}/`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${RECALL_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ClawPilot-Bridge/1.0'
      },
      body: JSON.stringify(body)
    });

    const data = await response.text();
    const launchFallback = {
      status: response.ok ? 'launch_requested' : 'launch_failed',
      meeting_url,
      meeting_session: normalizeMeetingSessionId(launchSessionId),
      routing_target: effectiveRouteTarget || null,
      bot_name: resolvedBotName
    };
    try {
      const json = JSON.parse(data);
      if (replacedFromBotId) {
        launchFallback.replaced_from_bot_id = replacedFromBotId;
      }
      if (response.status >= 200 && response.status < 300 && json?.id) {
        rememberBotSession(json.id, launchSessionId);
        if (effectiveRouteTarget) {
          rememberBotRouteTarget(json.id, effectiveRouteTarget);
        }
        setSessionCopilotName(launchSessionId, resolvedBotName);
        setSessionTeamAgent(launchSessionId, requestedTeamAgent);
        if (requestedOwnerBinding) {
          setSessionOwnerBinding(launchSessionId, requestedOwnerBinding);
        }
        launchFallback.id = json.id;
      }
      return res.status(response.status).json(buildSafeLaunchResponse(json, launchFallback));
    } catch (e) {
      return res.status(response.status).json(buildSafeLaunchResponse(
        {
          error: 'Recall launch API returned a non-JSON response',
          code: `http_${response.status}`
        },
        launchFallback
      ));
    }
  } catch (err) {
    console.error('Launch error:', err);
    return res.status(500).json(buildSafeLaunchResponse(
      {
        error: 'Launch request failed',
        code: 'launch_request_failed'
      },
      {
        status: 'launch_failed',
        meeting_url,
        meeting_session: normalizeMeetingSessionId(launchSessionId),
        routing_target: effectiveRouteTarget || null,
        replaced_from_bot_id: replacedFromBotId || ''
      }
    ));
  }
});

// Main webhook endpoint
app.post('/webhook', async (req, res) => {
  const eventType = req.body?.event || 'unknown';
  const isTranscriptEvent =
    eventType === 'transcript.data' || eventType === 'transcript.partial_data';

  // Verify webhook token (strict for transcript events; permissive for status events).
  const token = req.query.token || req.query.webhook_token || req.query.secret || '';
  const tokenPreview = token ? `${String(token).slice(0, 8)}...` : 'missing';
  if (isTranscriptEvent && (!token || token !== WEBHOOK_SECRET)) {
    console.log(
      `[${new Date().toISOString()}] Webhook REJECTED - invalid token (${tokenPreview}) event=${eventType}`
    );
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isTranscriptEvent && (!token || token !== WEBHOOK_SECRET)) {
    console.log(
      `[${new Date().toISOString()}] Webhook accepted without token (status event) event=${eventType}`
    );
  }
  
  const event = req.body;
  
  console.log(
    `[${new Date().toISOString()}] Webhook received: ${eventType} token=${tokenPreview}`
  );
  
  try {
    switch (event.event) {
      // Bot status events (via Svix dashboard webhooks)
      case 'bot.joining_call':
      case 'bot.in_waiting_room':
      case 'bot.in_call_not_recording':
      case 'bot.in_call_recording':
      case 'bot.call_ended':
      case 'bot.done':
      case 'bot.fatal':
        await handleBotStatus(event);
        break;
      
      // Real-time transcript events (per-bot webhook)
      case 'transcript.data':
        await handleRecallTranscript(event.data, false, event);
        break;
      
      case 'transcript.partial_data':
        await handleRecallTranscript(event.data, true, event);
        break;
        
      default:
        console.log('Unhandled event type:', event.event);
        console.log('Full payload:', JSON.stringify(event, null, 2));
    }
    
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

async function handleBotStatus(event) {
  const eventType = event.event;
  const botId = event.data?.bot?.id || 'unknown';
  const sessionIdFromEvent = resolveSessionFromEvent(event, botId !== 'unknown' ? botId : null);
  if (botId !== 'unknown' && sessionIdFromEvent) {
    rememberBotSession(botId, sessionIdFromEvent);
  }
  const updatedAt = event.data?.data?.updated_at;
  console.log(`Bot ${botId} event: ${eventType}`);
  
  switch (eventType) {
    case 'bot.in_call_recording':
      if (botId !== 'unknown') {
        const parsed = updatedAt ? Date.parse(updatedAt) : NaN;
        meetingStartByBot.set(botId, Number.isFinite(parsed) ? parsed : Date.now());
      }
      transcriptBuffer = []; // Reset buffer for new meeting
      {
        const sessionId = sessionIdFromEvent || (botId !== 'unknown' ? meetingSessionByBotId.get(botId) : null) || activeMeetingSessionId;
        const normalizedSession = ensureSessionDefaults(sessionId);
        resetMeetingCanvasForSession(normalizedSession);
        if (botId !== 'unknown') {
          await announceMeetingState(botId, normalizedSession);
        }
      }
      console.log(`[BotReady] ${botId} recording started`);
      break;
    case 'bot.joining_call':
      console.log(`[BotStatus] ${botId} joining_call`);
      break;
    case 'bot.in_waiting_room':
      console.log(`[BotStatus] ${botId} in_waiting_room`);
      break;
    case 'bot.call_ended':
    case 'bot.done':
      if (botId !== 'unknown') {
        meetingStartByBot.delete(botId);
        relativeEpochBaseByBot.delete(botId);
        forgetBotSession(botId);
      }
      console.log(`[BotStatus] ${botId} ended`);
      break;
    case 'bot.fatal':
      if (botId !== 'unknown') {
        meetingStartByBot.delete(botId);
        relativeEpochBaseByBot.delete(botId);
        forgetBotSession(botId);
      }
      const subCode = event.data?.data?.sub_code || 'unknown';
      console.log(`[BotStatus] ${botId} fatal (${subCode})`);
      break;
  }
}

async function handleTranscript(data, isFinal) {
  // Full transcript update
  if (data.transcript) {
    const lines = data.transcript;
    if (Array.isArray(lines)) {
      transcriptBuffer = lines.map(l => ({
        speaker: l.speaker || 'Unknown',
        text: l.text || l.words?.map(w => w.text).join(' ') || ''
      }));
    }
  }
  
  if (isFinal) {
    await sendToOpenClaw(`📝 Final transcript received (${transcriptBuffer.length} segments)`);
  } else {
    await maybeReact();
  }
}

async function handleTranscriptItem(data) {
  // Real-time transcript item (Recall format: transcript.data / transcript.partial_data)
  const participant = data.data?.participant || {};
  const speaker = participant.name || 'Unknown';
  const words = data.data?.words || [];
  const text = words.map(w => w.text).join(' ');
  
  if (text) {
    transcriptBuffer.push({ speaker, text, timestamp: Date.now() });
    console.log(`[Transcript] ${speaker}: ${text}`);
    await maybeReact();
  }
}

function toEpochMs(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Heuristic: treat very large numbers as ms, otherwise seconds.
    return value > 1e12 ? value : value * 1000;
  }

  if (typeof value === 'string') {
    const num = Number(value);
    if (!Number.isNaN(num)) return toEpochMs(num);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function extractWordStartMs(word, botId, nowMs) {
  if (!word) return null;
  const ts = word.start_timestamp;
  if (ts === null || ts === undefined) return null;

  // Flat numeric/string formats.
  const flat = toEpochMs(ts);
  if (flat !== null) return flat;

  // Object formats from Recall.
  if (typeof ts === 'object') {
    const absoluteCandidates = [ts.absolute, ts.epoch, ts.unix, ts.ts];
    for (const candidate of absoluteCandidates) {
      const ms = toEpochMs(candidate);
      if (ms !== null) return ms;
    }

    if (typeof ts.relative === 'number' && Number.isFinite(ts.relative)) {
      const key = botId || '__unknown__';
      const startMs = meetingStartByBot.get(key);
      if (startMs) {
        return startMs + ts.relative * 1000;
      }

      const relativeBase = relativeEpochBaseByBot.get(key);
      if (relativeBase) {
        return relativeBase + ts.relative * 1000;
      }

      // First-seen fallback: learn an approximate base and wait for next chunk for stable latency.
      if (Number.isFinite(nowMs)) {
        relativeEpochBaseByBot.set(key, nowMs - ts.relative * 1000);
      }
    }
  }

  return null;
}

// Handle Recall's transcript.data and transcript.partial_data events
async function handleRecallTranscript(data, isPartial, event) {
  const participant = data.data?.participant || {};
  const speaker = participant.name || 'Unknown';
  const words = data.data?.words || [];
  const text = words.map(w => w.text).join(' ');
  const botId = event?.data?.bot?.id || data?.bot?.id || null;
  let eventSessionId = resolveSessionFromEvent(event, botId);
  if (!eventSessionId && botId) {
    eventSessionId = await hydrateBotSessionFromApi(botId);
  }
  if (!eventSessionId) {
    eventSessionId = activeMeetingSessionId;
  }
  if (botId && eventSessionId) {
    rememberBotSession(botId, eventSessionId);
  }
  
  if (text) {
    if (!isPartial) {
      const controlCommand = parseTranscriptControlCommand(speaker, text);
      if (controlCommand) {
        switch (controlCommand.type) {
          case 'mute':
            setMuteState(true, `voice:${speaker}`);
            break;
          case 'unmute':
            setMuteState(false, `voice:${speaker}`);
            break;
          case 'meetverbose_on':
            setMeetVerboseState(true, `voice:${speaker}`);
            break;
          case 'meetverbose_off':
            setMeetVerboseState(false, `voice:${speaker}`);
            break;
          default:
            break;
        }
        await sendToOpenClaw(`[MEETING CONTROL] ${controlCommand.ack}`, { botId, sessionId: eventSessionId });
        return;
      }
    }

    if (IS_MUTED) {
      if (!isPartial) {
        console.log(`[MUTED_DROP] ${speaker}: ${text}`);
      }
      return;
    }

    const nowMs = Date.now();
    const lastItem = transcriptBuffer[transcriptBuffer.length - 1];
    if (isPartial) {
      // Keep only the latest partial for the active speaker turn.
      if (lastItem && lastItem.partial && lastItem.speaker === speaker) {
        if (lastItem.text === text) {
          return;
        }
        lastItem.text = text;
        lastItem.timestamp = nowMs;
      } else {
        transcriptBuffer.push({ speaker, text, timestamp: nowMs, partial: true });
      }
    } else {
      // Final chunk should replace prior partial of same speaker when possible.
      if (lastItem && lastItem.partial && lastItem.speaker === speaker) {
        lastItem.text = text;
        lastItem.partial = false;
        lastItem.timestamp = nowMs;
      } else if (!(lastItem && !lastItem.partial && lastItem.speaker === speaker && lastItem.text === text)) {
        transcriptBuffer.push({ speaker, text, timestamp: nowMs, partial: false });
      }
    }
    console.log(`[${isPartial ? 'Partial' : 'Final'}] ${speaker}: ${text}`);
    const firstWord = words[0] || null;
    const lastWord = words[words.length - 1] || firstWord;
    const speechStartMs = extractWordStartMs(firstWord, botId, nowMs);
    const speechEndMs = extractWordStartMs(lastWord, botId, nowMs) || speechStartMs;
    const speechStartToWebhookMs = speechStartMs ? Math.max(0, Math.round(nowMs - speechStartMs)) : null;
    const speechEndToWebhookMs = speechEndMs ? Math.max(0, Math.round(nowMs - speechEndMs)) : null;
    console.log(
      `[LATENCY] bot=${botId || 'unknown'} event=${isPartial ? 'partial' : 'final'} speech_end_to_webhook_ms=${speechEndToWebhookMs ?? 'unknown'} speech_start_to_webhook_ms=${speechStartToWebhookMs ?? 'unknown'} first_word_ts=${JSON.stringify(firstWord?.start_timestamp ?? null)} last_word_ts=${JSON.stringify(lastWord?.start_timestamp ?? null)}`
    );
    
    // Send typing indicator to show we're listening
    sendTypingIndicator();
    
    // Debug mode: send raw transcript (only final, not partial - too spammy)
    if (!isPartial && !IS_MUTED) {
      sendDebugTranscript(speaker, text, isPartial, { botId });
      appendTranscriptToCanvas(eventSessionId, speaker, text, botId);
    }
    
    const force = !isPartial && hasHighValueCue(text);
    if (!isPartial || REACT_ON_PARTIAL) {
      await maybeReact({
        webhookReceivedAtMs: nowMs,
        speechToWebhookMs: speechEndToWebhookMs,
        botId,
        sessionId: eventSessionId,
        isPartial,
        force
      });
    }
  }
}

function buildReactionCandidate(meta = {}) {
  const isPartial = Boolean(meta.isPartial);
  const force = Boolean(meta.force);
  const contextWindow = isPartial ? PARTIAL_CONTEXT_WINDOW : FINAL_CONTEXT_WINDOW;
  const recentItems = transcriptBuffer.slice(-contextWindow);
  const recentText = recentItems.map(i => i.text).join(' ');
  const wordCount = recentText.trim() ? recentText.trim().split(/\s+/).length : 0;
  const minWords = isPartial ? PARTIAL_MIN_NEW_WORDS : MIN_NEW_WORDS;
  if (!force && wordCount < minWords) {
    return null;
  }

  const context = recentItems.map(i => `${i.speaker}: ${i.text}`).join('\n');
  if (!context) {
    return null;
  }

  return {
    isPartial,
    meta,
    context,
    contextKey: `${normalizeSessionInput(meta.sessionId)}:${isPartial ? 'partial' : 'final'}:${context}`,
    createdAt: Date.now(),
    force
  };
}

function scheduleQueuedReaction(ms) {
  if (queuedReactionTimer) {
    return;
  }
  queuedReactionTimer = setTimeout(async () => {
    queuedReactionTimer = null;
    await flushQueuedReaction();
  }, Math.max(10, ms));
}

async function flushQueuedReaction() {
  if (IS_MUTED || reactionInFlight || !queuedReaction) {
    return;
  }

  const now = Date.now();
  const next = queuedReaction;
  const sinceLastFinal = now - lastReactionTime;
  const sinceLastPartial = now - lastPartialReactionTime;
  if (!next.force && !next.isPartial && sinceLastFinal < REACTION_COOLDOWN_MS) {
    scheduleQueuedReaction(REACTION_COOLDOWN_MS - sinceLastFinal);
    return;
  }
  if (!next.force && next.isPartial && sinceLastPartial < PARTIAL_REACTION_DEBOUNCE_MS) {
    scheduleQueuedReaction(PARTIAL_REACTION_DEBOUNCE_MS - sinceLastPartial);
    return;
  }

  queuedReaction = null;
  await runReaction(next, 'queued');
}

async function runReaction(candidate, source) {
  const now = Date.now();
  const reactionId = ++reactionSeq;
  reactionInFlight = true;
  lastReactionContextKey = candidate.contextKey;
  lastReactionTime = now;
  if (candidate.isPartial) {
    lastPartialReactionTime = now;
  }

  console.log(
    `[PROFILE] Starting reaction id=${reactionId} source=${source} kind=${candidate.isPartial ? 'partial' : 'final'} at=${now}`
  );

  try {
    const sessionId = ensureSessionDefaults(candidate.meta.sessionId || activeMeetingSessionId);
    const promptInput = buildPromptInput(sessionId, candidate.context);
    const renderedPrompt = promptManager.renderPrompt(promptInput);
    if (renderedPrompt.error) {
      console.warn(`[PromptLoader] ${renderedPrompt.error}`);
    }
    const hadRevealGrant = Boolean(getSessionRevealGrant(sessionId));
    const injectMs = await sendToOpenClaw(
      renderedPrompt.prompt,
      { botId: candidate.meta.botId, sessionId }
    );
    if (hadRevealGrant && getSessionAudience(sessionId) === 'shared') {
      consumeSessionRevealGrant(sessionId);
    }
    const webhookToInjectMs = candidate.meta.webhookReceivedAtMs
      ? Math.max(0, Date.now() - candidate.meta.webhookReceivedAtMs)
      : null;
    console.log(
      `[LATENCY] bot=${candidate.meta.botId || 'unknown'} event=${candidate.isPartial ? 'partial' : 'final'} speech_to_webhook_ms=${candidate.meta.speechToWebhookMs ?? 'unknown'} webhook_to_inject_ms=${webhookToInjectMs ?? 'unknown'} inject_call_ms=${injectMs ?? 'unknown'}`
    );
  } finally {
    reactionInFlight = false;
    await flushQueuedReaction();
  }
}

async function maybeReact(meta = {}) {
  if (IS_MUTED) {
    return;
  }

  const candidate = buildReactionCandidate(meta);
  if (!candidate || candidate.contextKey === lastReactionContextKey) {
    return;
  }

  if (reactionInFlight) {
    if (queuedReaction && queuedReaction.contextKey === candidate.contextKey) {
      return;
    }
    queuedReaction = candidate;
    console.log(
      `[QUEUE] Coalesced latest reaction kind=${candidate.isPartial ? 'partial' : 'final'} words=${candidate.context.split(/\s+/).length}`
    );
    return;
  }

  const now = Date.now();
  if (!candidate.force && !candidate.isPartial && now - lastReactionTime < REACTION_COOLDOWN_MS) {
    return;
  }
  if (!candidate.force && candidate.isPartial && now - lastPartialReactionTime < PARTIAL_REACTION_DEBOUNCE_MS) {
    return;
  }

  await runReaction(candidate, 'direct');
}

// Immediate reaction for important moments (no cooldown)
async function reactImmediate(message) {
  await sendToOpenClaw(message);
}

async function sendToOpenClaw(message, options = {}) {
  const sendStart = Date.now();
  const sessionId = ensureSessionDefaults(options.sessionId || activeMeetingSessionId);
  const routeTarget = resolveRouteTarget(options.routeTarget, options.botId);
  const routeText = formatRouteText(routeTarget, 'wake');
  const text = `[MEETING TRANSCRIPT]\n${message}`;
  let direct = null;
  try {
    // Routed delivery via OpenClaw hooks may resolve to NO_REPLY. Use the CLI pipeline first so
    // we can get model output synchronously and send it directly to the target channel.
    if (OPENCLAW_COPILOT_CLI_ROUTED && routeTarget?.channel && routeTarget?.to) {
      try {
        const copilotText = await generateCopilotTextViaCli(text, routeTarget);
        const guarded = applyPrivacyOutputGuard(copilotText, sessionId);
        await deliverTextViaCli(routeTarget, guarded.text);
        const elapsed = Date.now() - sendStart;
        console.log(`[FastInject] ${elapsed}ms - delivered_cli route=${routeText}`);
        return elapsed;
      } catch (cliError) {
        console.warn(`[FastInject] cli path failed route=${routeText} error=${cliError.message} fallback=openclaw`);
        if (getSessionAudience(sessionId) === 'shared') {
          // In shared mode, avoid fallback model paths when the guarded CLI path fails.
          return null;
        }
      }
    }

    if (!routeTarget?.channel || !routeTarget?.to) {
      direct = await tryDirectDelivery(routeTarget, text);
      if (direct.delivered) {
        const directResult = direct.result;
        const elapsed = Date.now() - sendStart;
        console.log(
          `[FastInject] ${elapsed}ms - delivered_direct route=${routeText} chunks=${directResult.chunksSent}/${directResult.chunksTotal}`
        );
        return elapsed;
      }
      if (direct.reason === 'failed') {
        console.warn(
          `[FastInject] direct failed route=${routeText} error=${direct.result?.error || 'unknown'} fallback=openclaw`
        );
      }
    }

    if (!OPENCLAW_HOOK_TOKEN) {
      console.error('[FastInject] OPENCLAW_HOOK_TOKEN is required.');
      return null;
    }

    let response;
    if (routeTarget?.channel && routeTarget?.to) {
      const payload = {
        message: text,
        name: 'ClawPilot Copilot',
        wakeMode: 'now',
        deliver: true,
        channel: routeTarget.channel,
        to: routeTarget.to
      };
      ({ response } = await postToOpenClawJson(OPENCLAW_AGENT_HOOK_URL, payload));
    } else {
      ({ response } = await postToOpenClawJson(OPENCLAW_HOOK_URL, { text, mode: "now" }));
    }

    const elapsed = Date.now() - sendStart;
    const usedFallback = direct?.attempted || direct?.reason === 'not_configured';
    const statusText = response.ok
      ? (usedFallback ? 'fallback_openclaw' : 'success')
      : (usedFallback ? 'failed_after_direct' : 'failed');
    console.log(`[FastInject] ${elapsed}ms - ${statusText} route=${routeText}`);
    return elapsed;
  } catch (error) {
    console.error("[FastInject] Error:", error.message);
    return null;
  }
}

// Meeting verbose mode toggle endpoints
app.post('/meetverbose/on', requireBridgeAuth, (req, res) => {
  const state = setMeetVerboseState(true, 'http:/meetverbose/on');
  res.json({ ...state, message: 'Raw transcript mirror ON (active chat channel)' });
});

app.post('/meetverbose/off', requireBridgeAuth, (req, res) => {
  const state = setMeetVerboseState(false, 'http:/meetverbose/off');
  res.json({ ...state, message: 'Raw transcript mirror OFF - smart feedback only' });
});

app.get('/meetverbose', (req, res) => {
  res.json({ meetverbose: DEBUG_MODE, muted: IS_MUTED });
});

// Support /meetverbose POST with flexible booleans in body/query/text.
app.post('/meetverbose', (req, res) => {
  const explicit =
    parseBooleanLike(req.body?.enabled, null) ??
    parseBooleanLike(req.body?.on, null) ??
    parseBooleanLike(req.query?.enabled, null) ??
    parseBooleanLike(req.query?.on, null);

  let textValue = null;
  if (typeof req.body?.text === 'string') {
    const match = req.body.text.match(/\b(on|off|true|false|1|0)\b/i);
    textValue = parseBooleanLike(match?.[1], null);
  }

  const nextValue = explicit ?? textValue;
  if (nextValue !== null) {
    setMeetVerboseState(nextValue, 'http:/meetverbose');
  }

  res.json({
    meetverbose: DEBUG_MODE,
    muted: IS_MUTED,
    message: DEBUG_MODE ? 'Raw transcript mirror ON (active chat channel)' : 'Raw transcript mirror OFF'
  });
});

// ============ MEETING CANVAS ============
const MEETING_MAX_TITLE_LEN = Number(process.env.MEETING_MAX_TITLE_LEN || 180);
const MEETING_MAX_CONTENT_LEN = Number(process.env.MEETING_MAX_CONTENT_LEN || 2000);

function getMeetingSessionId(req) {
  const requested = req.query?.session || req.body?.session;
  if (typeof requested === 'string' && requested.trim()) {
    return meeting.resolveSessionId(requested);
  }
  return normalizeMeetingSessionId(activeMeetingSessionId);
}

function readBoundedString(raw, maxLen) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) return null;
  return trimmed;
}

function readMeetingContent(req) {
  return req.body?.content ?? req.body?.text ?? null;
}

// Serve the meeting page
app.get('/meeting', requireBridgeAuth, (req, res) => {
  if (!req.query?.session && activeMeetingSessionId && activeMeetingSessionId !== 'default') {
    return res.redirect(302, `/meeting?session=${encodeURIComponent(activeMeetingSessionId)}`);
  }
  res.setHeader('Content-Type', 'text/html');
  res.send(meeting.meetingHTML);
});

// SSE stream for real-time updates
app.get('/meeting/stream', requireBridgeAuth, (req, res) => {
  const sessionId = getMeetingSessionId(req);
  const lastEventId = req.get('Last-Event-ID') || req.query?.lastEventId || 0;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  
  const client = meeting.addSseClient(res, sessionId, lastEventId);
  console.log(`[Meeting] Client connected session=${sessionId} (${meeting.sseClients.size} total)`);
  
  req.on('close', () => {
    meeting.removeSseClient(client);
    console.log(`[Meeting] Client disconnected session=${sessionId} (${meeting.sseClients.size} total)`);
  });
  req.on('error', () => {
    meeting.removeSseClient(client);
  });
});

// API to add/update/delete sections
app.post('/meeting/section', (req, res) => {
  const sessionId = getMeetingSessionId(req);
  const type = String(req.body?.type || 'bullet');
  const content = readBoundedString(readMeetingContent(req), MEETING_MAX_CONTENT_LEN);
  const meta = req.body?.meta ?? {};

  if (!meeting.ALLOWED_SECTION_TYPES.has(type)) {
    return res.status(400).json({ error: 'invalid type' });
  }
  if (!content) {
    return res.status(400).json({ error: 'content required (1-2000 chars)' });
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return res.status(400).json({ error: 'meta must be an object' });
  }

  const section = meeting.addSection(sessionId, type, content, meta);
  const state = meeting.getSessionState(sessionId);
  res.json({ ok: true, session: sessionId, id: section.id, count: state.sections.length });
});

app.patch('/meeting/section/:id', (req, res) => {
  const sessionId = getMeetingSessionId(req);
  const content = readBoundedString(readMeetingContent(req), MEETING_MAX_CONTENT_LEN);
  if (!content) {
    return res.status(400).json({ error: 'content required (1-2000 chars)' });
  }
  const updated = meeting.updateSection(sessionId, req.params.id, content);
  if (!updated) {
    return res.status(404).json({ error: 'section not found' });
  }
  res.json({ ok: true, session: sessionId });
});

app.delete('/meeting/section/:id', (req, res) => {
  const sessionId = getMeetingSessionId(req);
  const deleted = meeting.deleteSection(sessionId, req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'section not found' });
  }
  res.json({ ok: true, session: sessionId });
});

app.post('/meeting/title', (req, res) => {
  const sessionId = getMeetingSessionId(req);
  const title = readBoundedString(req.body?.title, MEETING_MAX_TITLE_LEN);
  if (!title) {
    return res.status(400).json({ error: 'title required (1-180 chars)' });
  }
  meeting.setTitle(sessionId, title);
  res.json({ ok: true, session: sessionId });
});

app.post('/meeting/clear', (req, res) => {
  const sessionId = getMeetingSessionId(req);
  meeting.clearMeeting(sessionId);
  res.json({ ok: true, session: sessionId });
});

// Get current state
app.get('/meeting/state', requireBridgeAuth, (req, res) => {
  const sessionId = getMeetingSessionId(req);
  res.json(meeting.getPublicState(sessionId));
});

console.log('[Meeting] Canvas endpoints ready at /meeting');

// Start server after all routes are registered.
app.listen(PORT, HOST, () => {
  console.log(`Recall webhook server running on port ${PORT}`);
  console.log(`Webhook URL: ${WEBHOOK_BASE_URL.replace(/\/$/, '')}/webhook`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`[OpenClawHook] wake=${OPENCLAW_HOOK_URL} agent=${OPENCLAW_AGENT_HOOK_URL}`);
  console.log(`[BridgeAuth] ${BRIDGE_AUTH_ENABLED ? 'enabled' : 'disabled'}${BRIDGE_AUTH_ENABLED ? '' : ' (set BRIDGE_API_TOKEN to enforce bearer auth on bridge control routes)'}`);
  console.log(`[OpenClawHook] token=${OPENCLAW_HOOK_TOKEN ? 'set' : 'missing'} url_source=${OPENCLAW_HOOK_URL_SOURCE} token_source=${OPENCLAW_HOOK_TOKEN_SOURCE}`);
  console.log(`[Prompt] path=${promptManager.getPromptPath()} default_mode=${resolveModeOrDefault(promptManager.getDefaultMode())}`);
  if (!OPENCLAW_HOOK_TOKEN) {
    console.warn(`[OpenClawHook] token missing. Configure hooks.token in ${OPENCLAW_HOOK_DEFAULTS.configPath}`);
  }
});
