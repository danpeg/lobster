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
  if (providedAgentName) {
    const suffix = sanitizeBotName(process.env.RECALL_BOT_NAME_SUFFIX || 'Note Taker', 'Note Taker');
    return sanitizeBotName(`${providedAgentName} ${suffix}`, `${providedAgentName} Note Taker`);
  }

  const agentName = sanitizeBotName(
    process.env.OPENCLAW_AGENT_NAME || process.env.CLAW_AGENT_NAME || process.env.AGENT_NAME || ''
  );
  const suffix = sanitizeBotName(process.env.RECALL_BOT_NAME_SUFFIX || 'Note Taker', 'Note Taker');
  const base = agentName || 'OpenClaw';
  return sanitizeBotName(`${base} ${suffix}`, 'OpenClaw Note Taker');
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
  function pickFirstNumber(candidates) {
    for (const value of candidates) {
      const num = Number(value);
      if (Number.isFinite(num)) return Math.round(num);
    }
    return null;
  }
  function pickFirstBoolean(candidates) {
    for (const value of candidates) {
      const parsed = parseBooleanLike(value, null);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  function pickFirstStringArray(candidates) {
    for (const value of candidates) {
      if (Array.isArray(value)) {
        const normalized = value
          .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
          .filter(Boolean);
        if (normalized.length) return normalized;
      }
      if (typeof value === 'string') {
        const normalized = value
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean);
        if (normalized.length) return normalized;
      }
    }
    return [];
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
    const clawpilotCfg = cfg?.plugins?.entries?.clawpilot?.config || {};
    const voiceCfg = typeof clawpilotCfg?.voice === 'object' && clawpilotCfg.voice
      ? clawpilotCfg.voice
      : {};
    const elevenlabsCfg = (cfg?.integrations && typeof cfg.integrations.elevenlabs === 'object')
      ? cfg.integrations.elevenlabs
      : {};
    const elevenlabsApiKey = pickFirstString([
      voiceCfg?.elevenlabsApiKey,
      elevenlabsCfg?.apiKey,
      elevenlabsCfg?.key,
      elevenlabsCfg?.token
    ]);
    const elevenlabsVoiceId = pickFirstString([
      voiceCfg?.voiceId,
      elevenlabsCfg?.voiceId
    ]);
    const elevenlabsModelId = pickFirstString([
      voiceCfg?.modelId,
      elevenlabsCfg?.modelId
    ]);
    const voiceEnabled = pickFirstBoolean([
      voiceCfg?.enabled,
      clawpilotCfg?.voiceEnabled
    ]);
    const voiceCooldownMs = pickFirstNumber([
      voiceCfg?.cooldownMs,
      clawpilotCfg?.voiceCooldownMs
    ]);
    const voiceMinSilenceMs = pickFirstNumber([
      voiceCfg?.minSilenceMs,
      clawpilotCfg?.voiceMinSilenceMs
    ]);
    const voiceMaxChars = pickFirstNumber([
      voiceCfg?.maxChars,
      clawpilotCfg?.voiceMaxChars
    ]);
    const voiceMirrorToChat = pickFirstBoolean([
      voiceCfg?.mirrorToChat,
      clawpilotCfg?.voiceMirrorToChat
    ]);
    const voiceWakeNames = pickFirstStringArray([
      voiceCfg?.wakeNames,
      clawpilotCfg?.voiceWakeNames
    ]);
    const voiceAutomaticAudioOutput = pickFirstBoolean([
      voiceCfg?.automaticAudioOutput,
      voiceCfg?.recallAutomaticAudioOutput,
      clawpilotCfg?.voiceAutomaticAudioOutput
    ]);
    const voiceAutomaticAudioB64 = pickFirstString([
      voiceCfg?.automaticAudioB64,
      voiceCfg?.recallAutomaticAudioB64,
      clawpilotCfg?.voiceAutomaticAudioB64
    ]);
    const voiceRequireWake = pickFirstBoolean([
      voiceCfg?.requireWake,
      clawpilotCfg?.voiceRequireWake
    ]);
    return {
      hookUrl: `http://127.0.0.1:${gatewayPort}${hooksPath}/wake`,
      hookToken,
      telegramBotToken,
      discordBotToken,
      elevenlabsApiKey,
      elevenlabsVoiceId,
      elevenlabsModelId,
      voiceEnabled,
      voiceCooldownMs,
      voiceMinSilenceMs,
      voiceMaxChars,
      voiceMirrorToChat,
      voiceWakeNames,
      voiceAutomaticAudioOutput,
      voiceAutomaticAudioB64,
      voiceRequireWake,
      configPath
    };
  } catch {
    return {
      hookUrl: '',
      hookToken: '',
      telegramBotToken: '',
      discordBotToken: '',
      elevenlabsApiKey: '',
      elevenlabsVoiceId: '',
      elevenlabsModelId: '',
      voiceEnabled: null,
      voiceCooldownMs: null,
      voiceMinSilenceMs: null,
      voiceMaxChars: null,
      voiceMirrorToChat: null,
      voiceWakeNames: [],
      voiceAutomaticAudioOutput: null,
      voiceAutomaticAudioB64: '',
      voiceRequireWake: null,
      configPath
    };
  }
}

const OPENCLAW_HOOK_DEFAULTS = readOpenClawHookDefaults();

// Webhook secret for verifying incoming requests
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || `http://127.0.0.1:${PORT}`;
const RECALL_API_BASE = String(process.env.RECALL_API_BASE || 'https://eu-central-1.recall.ai').replace(/\/+$/, '');
const RECALL_BOTS_ENDPOINT = `${RECALL_API_BASE}/api/v1/bot`;
const DEFAULT_RECALL_LANGUAGE = process.env.RECALL_LANGUAGE_CODE || 'en';
const DEFAULT_RECALL_STT_MODE = process.env.RECALL_STT_MODE || 'prioritize_low_latency';
const OPENCLAW_HOOK_URL = OPENCLAW_HOOK_DEFAULTS.hookUrl || 'http://127.0.0.1:18789/hooks/wake';
const OPENCLAW_HOOK_TOKEN = OPENCLAW_HOOK_DEFAULTS.hookToken || '';
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
const TELEGRAM_DIRECT_DELIVERY = parseBooleanLike(process.env.TELEGRAM_DIRECT_DELIVERY, true);
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
const TELEGRAM_DIRECT_MAX_RETRIES = 2;
const TELEGRAM_DIRECT_RETRY_BASE_MS = 1000;
const DEBUG_MIRROR_TELEGRAM = parseBooleanLike(process.env.DEBUG_MIRROR_TELEGRAM, false);
const CONTROL_SPEAKER_REGEX = process.env.CONTROL_SPEAKER_REGEX || '';
const DISCORD_BOT_TOKEN = OPENCLAW_HOOK_DEFAULTS.discordBotToken || '';
const DISCORD_BOT_TOKEN_SOURCE = OPENCLAW_HOOK_DEFAULTS.discordBotToken ? 'openclaw.json' : 'missing';
const DISCORD_DIRECT_DELIVERY = parseBooleanLike(process.env.DISCORD_DIRECT_DELIVERY, true);
const DISCORD_MAX_MESSAGE_CHARS = 2000;
const DISCORD_DIRECT_MAX_RETRIES = 2;
const DISCORD_DIRECT_RETRY_BASE_MS = 1000;
const ELEVENLABS_API_KEY = OPENCLAW_HOOK_DEFAULTS.elevenlabsApiKey || process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_API_KEY_SOURCE = OPENCLAW_HOOK_DEFAULTS.elevenlabsApiKey
  ? 'openclaw.json'
  : (process.env.ELEVENLABS_API_KEY ? 'env' : 'missing');
const ELEVENLABS_VOICE_ID = OPENCLAW_HOOK_DEFAULTS.elevenlabsVoiceId || process.env.ELEVENLABS_VOICE_ID || '';
const ELEVENLABS_VOICE_ID_SOURCE = OPENCLAW_HOOK_DEFAULTS.elevenlabsVoiceId
  ? 'openclaw.json'
  : (process.env.ELEVENLABS_VOICE_ID ? 'env' : 'missing');
const ELEVENLABS_MODEL_ID = OPENCLAW_HOOK_DEFAULTS.elevenlabsModelId || process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';
const VOICE_WAKE_NAMES = Array.isArray(OPENCLAW_HOOK_DEFAULTS.voiceWakeNames) && OPENCLAW_HOOK_DEFAULTS.voiceWakeNames.length
  ? OPENCLAW_HOOK_DEFAULTS.voiceWakeNames
  : ['fugu', 'clawpilot', 'copilot'];
const VOICE_COOLDOWN_MS = OPENCLAW_HOOK_DEFAULTS.voiceCooldownMs === null
  ? parseIntegerLike(process.env.VOICE_COOLDOWN_MS, 20000)
  : parseIntegerLike(OPENCLAW_HOOK_DEFAULTS.voiceCooldownMs, parseIntegerLike(process.env.VOICE_COOLDOWN_MS, 20000));
const VOICE_MIN_SILENCE_MS = OPENCLAW_HOOK_DEFAULTS.voiceMinSilenceMs === null
  ? parseIntegerLike(process.env.VOICE_MIN_SILENCE_MS, 1200)
  : parseIntegerLike(OPENCLAW_HOOK_DEFAULTS.voiceMinSilenceMs, parseIntegerLike(process.env.VOICE_MIN_SILENCE_MS, 1200));
const VOICE_MAX_CHARS = OPENCLAW_HOOK_DEFAULTS.voiceMaxChars === null
  ? parseIntegerLike(process.env.VOICE_MAX_CHARS, 220)
  : parseIntegerLike(OPENCLAW_HOOK_DEFAULTS.voiceMaxChars, parseIntegerLike(process.env.VOICE_MAX_CHARS, 220));
const VOICE_MIRROR_TO_CHAT = parseBooleanLike(OPENCLAW_HOOK_DEFAULTS.voiceMirrorToChat, true);
const VOICE_PROVIDER = process.env.VOICE_PROVIDER || 'elevenlabs';
const RECALL_SILENT_MP3_B64 =
  'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAFAAACvgBoaGhoaGho' +
  'aGhoaGhoaGhoaGhojo6Ojo6Ojo6Ojo6Ojo6Ojo6Ojo60tLS0tLS0tLS0tLS0tLS0tLS0tNra2tra2tra2tra2tra2tra2tra////////////////////////' +
  '//8AAAAATGF2YzYwLjMxAAAAAAAAAAAAAAAAJAMGAAAAAAAAAr4QurGFAAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMQpg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxFMDwAABpAAAACAA' +
  'ADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/' +
  '+xDEfIPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVf/7EMSmA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
const VOICE_AUTOMATIC_AUDIO_OUTPUT = parseBooleanLike(
  OPENCLAW_HOOK_DEFAULTS.voiceAutomaticAudioOutput,
  parseBooleanLike(process.env.VOICE_AUTOMATIC_AUDIO_OUTPUT, true)
);
const VOICE_AUTOMATIC_AUDIO_B64 = OPENCLAW_HOOK_DEFAULTS.voiceAutomaticAudioB64 || RECALL_SILENT_MP3_B64;
const VOICE_AUTOMATIC_AUDIO_SOURCE = OPENCLAW_HOOK_DEFAULTS.voiceAutomaticAudioB64
  ? 'openclaw.json'
  : 'builtin-silence';
const VOICE_REQUIRE_WAKE = parseBooleanLike(
  OPENCLAW_HOOK_DEFAULTS.voiceRequireWake,
  parseBooleanLike(process.env.VOICE_REQUIRE_WAKE, false)
);
const VOICE_TRIGGER_ON_PARTIAL = parseBooleanLike(process.env.VOICE_TRIGGER_ON_PARTIAL, true);
const VOICE_PRIME_ON_JOIN = parseBooleanLike(process.env.VOICE_PRIME_ON_JOIN, true);
const VOICE_PRIME_WAIT_TIMEOUT_MS = parseIntegerLike(process.env.VOICE_PRIME_WAIT_TIMEOUT_MS, 90000);
const VOICE_PRIME_POLL_MS = parseIntegerLike(process.env.VOICE_PRIME_POLL_MS, 2000);
let VOICE_ENABLED = parseBooleanLike(
  OPENCLAW_HOOK_DEFAULTS.voiceEnabled,
  parseBooleanLike(process.env.VOICE_ENABLED, false)
);

if (DISCORD_DIRECT_DELIVERY && !DISCORD_BOT_TOKEN) {
  console.warn('[DiscordDirect] DISCORD_DIRECT_DELIVERY enabled but Discord bot token was not found in openclaw.json. Falling back to OpenClaw hooks.');
}
if (VOICE_ENABLED && !ELEVENLABS_API_KEY) {
  console.warn('[VoiceMVP] Voice enabled but ElevenLabs API key is missing in openclaw.json. Voice output disabled until configured.');
}
if (VOICE_ENABLED && !ELEVENLABS_VOICE_ID) {
  console.warn('[VoiceMVP] Voice enabled but ElevenLabs voiceId is missing in openclaw.json. Voice output disabled until configured.');
}
if (VOICE_ENABLED && !VOICE_AUTOMATIC_AUDIO_OUTPUT) {
  console.warn('[VoiceMVP] Voice enabled but automatic audio output is disabled. Recall output_audio may fail unless the bot was launched with automatic_audio_output.');
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

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compactSpeechText(value, maxChars = VOICE_MAX_CHARS) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.slice(0, Math.max(1, maxChars)).trim();
}

function buildVoiceWakeCandidates() {
  const canonical = new Set(
    (Array.isArray(VOICE_WAKE_NAMES) ? VOICE_WAKE_NAMES : [])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean)
  );
  // Recall STT often hears "fugu" as "google".
  if (canonical.has('fugu')) {
    canonical.add('google');
  }
  return Array.from(canonical);
}

const VOICE_WAKE_CANDIDATES = buildVoiceWakeCandidates();
const VOICE_WAKE_REGEX = new RegExp(`\\b(?:${VOICE_WAKE_CANDIDATES.map(escapeRegExp).join('|')})\\b`, 'i');

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

function splitTelegramMessage(content, maxChars = TELEGRAM_MAX_MESSAGE_CHARS) {
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

function normalizeTelegramTarget(to) {
  const raw = String(to || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase().startsWith('telegram:')) {
    return raw.slice('telegram:'.length).trim();
  }
  return raw;
}

function formatTelegramError(parsedBody, raw) {
  if (parsedBody && typeof parsedBody.description === 'string') {
    return parsedBody.description;
  }
  const text = String(raw || '').trim();
  if (!text) return 'Unknown Telegram API error';
  return text.slice(0, 240);
}

async function postToTelegramDirect(target, content) {
  const chatId = normalizeTelegramTarget(target);
  if (!chatId) {
    return { ok: false, error: 'Missing telegram chat target', elapsed: 0, chunksTotal: 0, chunksSent: 0 };
  }

  const sendStart = Date.now();
  const chunks = splitTelegramMessage(content, TELEGRAM_MAX_MESSAGE_CHARS);
  if (!chunks.length) {
    return { ok: false, error: 'Message is empty', elapsed: 0, chunksTotal: 0, chunksSent: 0 };
  }

  const totalAttempts = TELEGRAM_DIRECT_MAX_RETRIES + 1;
  let chunksSent = 0;
  let messageId = null;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    let delivered = false;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            disable_web_page_preview: true
          })
        });

        const raw = await response.text();
        const parsedBody = safeParseJson(raw);
        const apiOk = parsedBody?.ok !== false;
        if (response.ok && apiOk) {
          delivered = true;
          chunksSent += 1;
          messageId = parsedBody?.result?.message_id || messageId;
          break;
        }

        const retryAfterSec = Number(parsedBody?.parameters?.retry_after);
        const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.ceil(retryAfterSec * 1000)
          : TELEGRAM_DIRECT_RETRY_BASE_MS * Math.max(1, attempt);
        const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
        if (retryable && attempt < totalAttempts) {
          console.warn(
            `[TelegramDirect] retry route=${chatId} chunk=${i + 1}/${chunks.length} status=${response.status} attempt=${attempt}/${totalAttempts} wait_ms=${waitMs}`
          );
          await sleep(waitMs);
          continue;
        }

        return {
          ok: false,
          error: formatTelegramError(parsedBody, raw),
          status: response.status,
          elapsed: Date.now() - sendStart,
          chunksTotal: chunks.length,
          chunksSent
        };
      } catch (error) {
        if (attempt < totalAttempts) {
          const waitMs = TELEGRAM_DIRECT_RETRY_BASE_MS * attempt;
          console.warn(
            `[TelegramDirect] retry route=${chatId} chunk=${i + 1}/${chunks.length} attempt=${attempt}/${totalAttempts} error=${error.message} wait_ms=${waitMs}`
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
  },
  telegram: {
    isEnabled: () => TELEGRAM_DIRECT_DELIVERY,
    isConfigured: () => Boolean(TELEGRAM_BOT_TOKEN),
    tokenSource: () => TELEGRAM_BOT_TOKEN_SOURCE,
    deliver: async (routeTarget, content) => postToTelegramDirect(routeTarget.to, content)
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

function parseVoiceTrigger(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const wakePattern = VOICE_WAKE_CANDIDATES.map(escapeRegExp).join('|');
  const hasWakeWord = VOICE_WAKE_REGEX.test(raw);

  if (hasWakeWord) {
    const directMatch = raw.match(
      new RegExp(`\\b(?:${wakePattern})\\b[\\s,:-]*(?:please\\s+)?(?:say|speak|answer|respond|share)\\b[\\s,:-]*(.+)$`, 'i')
    );
    if (directMatch?.[1]) {
      const directText = compactSpeechText(directMatch[1]);
      if (directText) return { kind: 'direct', text: directText };
    }

    const queryMatch = raw.match(new RegExp(`\\b(?:${wakePattern})\\b[\\s,:-]*(.+\\?)$`, 'i'));
    if (queryMatch?.[1]) {
      return { kind: 'question', text: compactSpeechText(queryMatch[1], 140) };
    }

  if (/\b(what do you think|please answer|answer please|any thoughts|help us|summarize|recap)\b/i.test(raw)) {
      return { kind: 'assist', text: '' };
    }
  }

  if (VOICE_REQUIRE_WAKE) {
    return null;
  }

  // No-wake mode: accept explicit "say/speak/answer" directives with light filler tolerated.
  const fallbackDirect = raw.match(
    /^(?:(?:uh|um|hey|yo|ok|okay|google|go)\s+){0,3}(?:(?:can|could|would|will)\s+you|i\s+want\s+you\s+to|i\s+need\s+you\s+to|please|just)?[\s,:-]*(?:say|speak|answer|respond|share)\b[\s,:-]*(.+)$/i
  );
  if (fallbackDirect?.[1]) {
    const directText = compactSpeechText(fallbackDirect[1]);
    if (directText) return { kind: 'direct', text: directText };
  }

  const fallbackQuestion = raw.match(
    /^(?:(?:uh|um|hey|yo|ok|okay|google|go)\s+){0,3}(?:(?:can|could|would|will)\s+you|please)?[\s,:-]*(?:answer|respond)\b[\s,:-]*(.+\?)$/i
  );
  if (fallbackQuestion?.[1]) {
    return { kind: 'question', text: compactSpeechText(fallbackQuestion[1], 140) };
  }

  return null;
}

function buildMvpVoiceReply(trigger, speaker) {
  if (trigger?.kind === 'direct' && trigger.text) {
    return compactSpeechText(trigger.text);
  }

  const recentFinals = transcriptBuffer
    .filter((item) => !item.partial && item.text)
    .slice(-8);
  const recentText = recentFinals.map((item) => item.text).join(' ').toLowerCase();
  const lastOther = [...recentFinals].reverse().find(
    (item) => item.speaker !== speaker && !VOICE_WAKE_REGEX.test(item.text)
  );
  const cue = compactSpeechText(lastOther?.text || '', 120);

  let tail = 'Let us align on the decision, owner, and next step before we move on.';
  if (/\b(price|pricing|budget|cost|spend)\b/.test(recentText)) {
    tail = 'Let us agree the budget range and owner before committing next actions.';
  } else if (/\b(timeline|deadline|date|when|schedule)\b/.test(recentText)) {
    tail = 'Let us lock the timeline and assign one owner for the next milestone.';
  } else if (/\b(risk|concern|blocker|issue|problem)\b/.test(recentText)) {
    tail = 'Let us name the biggest blocker and pick one concrete mitigation now.';
  }

  const prefix = cue ? `Quick take: ${cue}. ` : 'Quick take: ';
  return compactSpeechText(`${prefix}${tail}`);
}

async function synthesizeElevenLabsSpeech(text) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL_ID
      })
    }
  );

  const payloadBuffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const errorText = payloadBuffer.toString('utf8').slice(0, 240);
    return { ok: false, status: response.status, error: errorText || 'ElevenLabs request failed' };
  }

  if (!payloadBuffer.length) {
    return { ok: false, error: 'ElevenLabs returned empty audio payload' };
  }

  return { ok: true, b64Data: payloadBuffer.toString('base64') };
}

async function postRecallAudioPayload(botId, endpoint, payload) {
  const response = await fetch(`${RECALL_BOTS_ENDPOINT}/${botId}/${endpoint}/`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${RECALL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const raw = await response.text();
  const parsed = safeParseJson(raw) || raw;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: typeof parsed === 'string' ? parsed.slice(0, 240) : JSON.stringify(parsed).slice(0, 240)
    };
  }
  return { ok: true, status: response.status };
}

async function sendRecallOutputAudio(botId, b64Data) {
  const payload = { kind: 'mp3', b64_data: b64Data };
  const primary = await postRecallAudioPayload(botId, 'output_audio', payload);
  if (primary.ok) {
    return { ok: true, endpoint: 'output_audio', status: primary.status };
  }

  if (primary.status !== 404 && primary.status !== 405) {
    return { ...primary, endpoint: 'output_audio' };
  }

  const fallback = await postRecallAudioPayload(botId, 'output_media', payload);
  if (fallback.ok) {
    return { ok: true, endpoint: 'output_media', status: fallback.status };
  }
  return {
    ...fallback,
    endpoint: 'output_media',
    fallback_from: 'output_audio',
    primary_error: primary.error
  };
}

const lastVoiceAtByBotId = new Map();
const voiceTaskByBotId = new Map();
const voicePrimedBotIds = new Set();
let lastVoiceDebug = {
  at: null,
  stage: 'init',
  bot_id: null,
  speaker: null,
  transcript: null,
  trigger: null,
  result: null
};
let lastPrimeDebug = {
  at: null,
  stage: 'init',
  bot_id: null,
  result: null
};

function enqueueVoiceTask(botId, taskFn) {
  const key = botId || '__global__';
  const previous = voiceTaskByBotId.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(taskFn)
    .finally(() => {
      if (voiceTaskByBotId.get(key) === next) {
        voiceTaskByBotId.delete(key);
      }
    });
  voiceTaskByBotId.set(key, next);
  return next;
}

function voiceConfigured() {
  return Boolean(VOICE_ENABLED && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && RECALL_API_KEY);
}

async function maybePrimeVoiceOutputOnJoin(botId) {
  if (!botId || !VOICE_PRIME_ON_JOIN || !VOICE_AUTOMATIC_AUDIO_OUTPUT || !RECALL_API_KEY) {
    lastPrimeDebug = {
      at: new Date().toISOString(),
      stage: 'prime_skipped_config',
      bot_id: botId || null,
      result: null
    };
    return;
  }
  if (voicePrimedBotIds.has(botId)) {
    lastPrimeDebug = {
      at: new Date().toISOString(),
      stage: 'prime_skipped_already',
      bot_id: botId,
      result: null
    };
    return;
  }
  lastPrimeDebug = {
    at: new Date().toISOString(),
    stage: 'prime_requested',
    bot_id: botId,
    result: null
  };
  voicePrimedBotIds.add(botId);
  const prime = await sendRecallOutputAudio(botId, VOICE_AUTOMATIC_AUDIO_B64);
  if (!prime.ok) {
    // Allow retry on next trigger/launch monitor tick.
    voicePrimedBotIds.delete(botId);
    console.warn(
      `[VoiceMVP] prime_on_join failed bot=${botId} status=${prime.status || 'n/a'} error=${prime.error || 'unknown'}`
    );
    lastPrimeDebug = {
      at: new Date().toISOString(),
      stage: 'prime_failed',
      bot_id: botId,
      result: {
        status: prime.status || null,
        error: prime.error || 'unknown'
      }
    };
    return;
  }
  lastPrimeDebug = {
    at: new Date().toISOString(),
    stage: 'prime_ok',
    bot_id: botId,
    result: {
      endpoint: prime.endpoint || null,
      status: prime.status || null
    }
  };
  console.log(`[VoiceMVP] prime_on_join ok bot=${botId} endpoint=${prime.endpoint}`);
}

async function schedulePrimeOnLaunch(botId) {
  if (!botId || !VOICE_PRIME_ON_JOIN) return;
  lastPrimeDebug = {
    at: new Date().toISOString(),
    stage: 'launch_monitor_started',
    bot_id: botId || null,
    result: null
  };
  const deadline = Date.now() + Math.max(10000, VOICE_PRIME_WAIT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const code = await getBotStatusCode(botId);
    if (code === 'in_call_recording') {
      lastPrimeDebug = {
        at: new Date().toISOString(),
        stage: 'launch_monitor_recording',
        bot_id: botId,
        result: code
      };
      await maybePrimeVoiceOutputOnJoin(botId);
      return;
    }
    if (isTerminalBotCode(code)) {
      lastPrimeDebug = {
        at: new Date().toISOString(),
        stage: 'launch_monitor_terminal',
        bot_id: botId,
        result: code
      };
      console.log(`[VoiceMVP] prime_on_join skipped bot=${botId} terminal_status=${code}`);
      return;
    }
    await sleep(Math.max(500, VOICE_PRIME_POLL_MS));
  }
  lastPrimeDebug = {
    at: new Date().toISOString(),
    stage: 'launch_monitor_timeout',
    bot_id: botId,
    result: VOICE_PRIME_WAIT_TIMEOUT_MS
  };
  console.warn(`[VoiceMVP] prime_on_join timeout bot=${botId} wait_ms=${VOICE_PRIME_WAIT_TIMEOUT_MS}`);
}

async function maybeSpeakTriggeredLine({ botId, speaker, text, isPartial = false }) {
  lastVoiceDebug = {
    at: new Date().toISOString(),
    stage: 'received',
    bot_id: botId || null,
    speaker: speaker || null,
    transcript: String(text || ''),
    is_partial: Boolean(isPartial),
    trigger: null,
    result: null
  };
  if (!VOICE_ENABLED) return;
  const trigger = parseVoiceTrigger(text);
  if (!trigger) return;
  if (isPartial && (!VOICE_TRIGGER_ON_PARTIAL || trigger.kind !== 'direct')) return;
  lastVoiceDebug.trigger = trigger;
  lastVoiceDebug.stage = 'trigger_detected';
  if (!botId) {
    console.warn('[VoiceMVP] Trigger detected but bot_id missing; cannot send output_audio.');
    lastVoiceDebug.stage = 'failed_missing_bot_id';
    lastVoiceDebug.result = 'missing_bot_id';
    return;
  }
  if (!voiceConfigured()) {
    console.warn('[VoiceMVP] Trigger detected but voice is not fully configured.');
    lastVoiceDebug.stage = 'failed_not_configured';
    lastVoiceDebug.result = 'not_configured';
    return;
  }

  await enqueueVoiceTask(botId, async () => {
    lastVoiceDebug.stage = 'queued';
    const now = Date.now();
    const lastVoiceAt = lastVoiceAtByBotId.get(botId) || 0;
    if (now - lastVoiceAt < VOICE_COOLDOWN_MS) {
      console.log(`[VoiceMVP] cooldown skip bot=${botId} wait_ms=${VOICE_COOLDOWN_MS - (now - lastVoiceAt)}`);
      lastVoiceDebug.stage = 'cooldown_skip';
      lastVoiceDebug.result = `wait_ms=${VOICE_COOLDOWN_MS - (now - lastVoiceAt)}`;
      return;
    }

    await sleep(VOICE_MIN_SILENCE_MS);
    const line = buildMvpVoiceReply(trigger, speaker);
    if (!line) return;
    lastVoiceDebug.stage = 'tts_request';
    lastVoiceDebug.result = line;

    const tts = await synthesizeElevenLabsSpeech(line);
    if (!tts.ok) {
      console.error(`[VoiceMVP] TTS failed bot=${botId} error=${tts.error || 'unknown'}`);
      lastVoiceDebug.stage = 'tts_failed';
      lastVoiceDebug.result = tts.error || 'unknown';
      return;
    }
    lastVoiceDebug.stage = 'tts_ok';

    const delivery = await sendRecallOutputAudio(botId, tts.b64Data);
    if (!delivery.ok) {
      console.error(
        `[VoiceMVP] Recall ${delivery.endpoint || 'output_audio'} failed bot=${botId} status=${delivery.status || 'n/a'} error=${delivery.error || 'unknown'}`
      );
      lastVoiceDebug.stage = 'delivery_failed';
      lastVoiceDebug.result = {
        endpoint: delivery.endpoint || null,
        status: delivery.status || null,
        error: delivery.error || 'unknown'
      };
      return;
    }

    lastVoiceAtByBotId.set(botId, Date.now());
    console.log(`[VoiceMVP] spoke bot=${botId} speaker=${speaker} chars=${line.length} endpoint=${delivery.endpoint}`);
    lastVoiceDebug.stage = 'spoke';
    lastVoiceDebug.result = { endpoint: delivery.endpoint || null, chars: line.length };
    if (VOICE_MIRROR_TO_CHAT) {
      await sendVerboseMirrorToOpenClaw(`[MEETING VOICE] ${line}`, { botId });
    }
  });
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
let activeMeetingSessionId = 'default';
let activeRouteTarget = null;

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
  if (!channel || !to) return null;
  return { channel, to };
}

function rememberBotRouteTarget(botId, routeTarget) {
  if (!botId) return;
  const normalized = normalizeRouteTarget(routeTarget);
  if (!normalized) return;
  routeTargetByBotId.set(botId, normalized);
  activeRouteTarget = normalized;
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

function setVoiceState(nextEnabled, reason = 'manual') {
  VOICE_ENABLED = Boolean(nextEnabled);
  console.log(`[VOICE ${VOICE_ENABLED ? 'ON' : 'OFF'}] Meeting speech ${VOICE_ENABLED ? 'enabled' : 'disabled'} reason=${reason}`);
  return { muted: IS_MUTED, meetverbose: DEBUG_MODE, voice: VOICE_ENABLED };
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
  if (['/voice on', 'voice on', 'meeting voice on'].includes(normalized)) {
    return { type: 'voice_on', ack: 'Meeting voice is ON. I will speak when explicitly asked.' };
  }
  if (['/voice off', 'voice off', 'meeting voice off'].includes(normalized)) {
    return { type: 'voice_off', ack: 'Meeting voice is OFF. I will remain text-only.' };
  }
  return null;
}

function hasHighValueCue(text) {
  const normalized = normalizeControlText(text);
  if (!normalized) return false;
  return /\b(what should i|should i|i dont know|i don't know|stuck|low energy|problem|issue|objection|decision|next step|what do i do|help me)\b/.test(normalized);
}

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    muted: IS_MUTED,
    meetverbose: DEBUG_MODE,
    proactivity: PROACTIVITY_LEVEL,
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
    voice: {
      enabled: VOICE_ENABLED,
      provider: VOICE_PROVIDER,
      configured: voiceConfigured(),
      automatic_audio_output: VOICE_AUTOMATIC_AUDIO_OUTPUT,
      prime_on_join: VOICE_PRIME_ON_JOIN,
      automatic_audio_payload_source: VOICE_AUTOMATIC_AUDIO_SOURCE,
      require_wake: VOICE_REQUIRE_WAKE,
      trigger_on_partial: VOICE_TRIGGER_ON_PARTIAL,
      wake_names: VOICE_WAKE_NAMES,
      cooldown_ms: VOICE_COOLDOWN_MS,
      min_silence_ms: VOICE_MIN_SILENCE_MS,
      max_chars: VOICE_MAX_CHARS,
      mirror_to_chat: VOICE_MIRROR_TO_CHAT,
      elevenlabs_api_key_source: ELEVENLABS_API_KEY_SOURCE,
      elevenlabs_voice_id_source: ELEVENLABS_VOICE_ID_SOURCE,
      queue_size: voiceTaskByBotId.size
    },
    direct_delivery_adapters: getDirectDeliveryStatus(),
    telegram: {
      token_set: Boolean(TELEGRAM_BOT_TOKEN),
      token_source: TELEGRAM_BOT_TOKEN_SOURCE
    }
  });
});

// Mute/unmute endpoints
app.post('/mute', (req, res) => {
  const state = setMuteState(true, 'http:/mute');
  res.json({ ...state, message: 'Transcript processing paused' });
});

app.post('/unmute', (req, res) => {
  const state = setMuteState(false, 'http:/unmute');
  res.json({ ...state, message: 'Transcript processing resumed' });
});

app.get('/mute-status', (req, res) => {
  res.json({ muted: IS_MUTED });
});

app.get('/copilot/status', (req, res) => {
  res.json({
    muted: IS_MUTED,
    meetverbose: DEBUG_MODE,
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
    voice: {
      enabled: VOICE_ENABLED,
      provider: VOICE_PROVIDER,
      configured: voiceConfigured(),
      automatic_audio_output: VOICE_AUTOMATIC_AUDIO_OUTPUT,
      prime_on_join: VOICE_PRIME_ON_JOIN,
      automatic_audio_payload_source: VOICE_AUTOMATIC_AUDIO_SOURCE,
      require_wake: VOICE_REQUIRE_WAKE,
      trigger_on_partial: VOICE_TRIGGER_ON_PARTIAL,
      wake_names: VOICE_WAKE_NAMES,
      cooldown_ms: VOICE_COOLDOWN_MS,
      min_silence_ms: VOICE_MIN_SILENCE_MS,
      max_chars: VOICE_MAX_CHARS,
      mirror_to_chat: VOICE_MIRROR_TO_CHAT,
      elevenlabs_api_key_source: ELEVENLABS_API_KEY_SOURCE,
      elevenlabs_voice_id_source: ELEVENLABS_VOICE_ID_SOURCE,
      queue_size: voiceTaskByBotId.size
    },
    direct_delivery_adapters: getDirectDeliveryStatus(),
    telegram: {
      token_set: Boolean(TELEGRAM_BOT_TOKEN),
      token_source: TELEGRAM_BOT_TOKEN_SOURCE
    }
  });
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
    return;
  }
  if (meetingSessionByBotId.size === 0) {
    activeMeetingSessionId = 'default';
  } else {
    activeMeetingSessionId = Array.from(meetingSessionByBotId.values()).at(-1) || 'default';
  }
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
app.post('/launch', async (req, res) => {
  const { meeting_url, language, provider, replace_active, bot_name, agent_name, route_target } = req.body;
  
  if (!meeting_url) {
    return res.status(400).json({ error: 'meeting_url required' });
  }
  const requestedRouteTarget = normalizeRouteTarget(route_target);
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
      return res.status(409).json({
        id: existingBot.id,
        status: 'already_active',
        meeting_url,
        existing_bot: existingBot,
        routing_target: effectiveRouteTarget || null
      });
    }
    const removal = await removeBotFromCall(existingBot.id);
    if (!removal.ok) {
      return res.status(502).json({
        status: 'replace_failed',
        meeting_url,
        existing_bot: existingBot,
        remove_error: removal
      });
    }
    const waitResult = await waitForBotTerminal(existingBot.id);
    if (!waitResult.ok) {
      return res.status(409).json({
        status: 'replace_timeout',
        meeting_url,
        existing_bot: existingBot,
        wait_result: waitResult
      });
    }
    replacedFromBotId = existingBot.id;
    forgetBotSession(existingBot.id);
  }

  const requestedLang = language || DEFAULT_RECALL_LANGUAGE;
  const lang = requestedLang === 'multi' ? 'auto' : requestedLang;
  const prov = provider || 'recallai_streaming';
  const resolvedBotName = resolveBotName({ requested: bot_name, agentName: agent_name });

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
  const launchBody = { ...body };
  if (VOICE_AUTOMATIC_AUDIO_OUTPUT && VOICE_AUTOMATIC_AUDIO_B64) {
    launchBody.automatic_audio_output = {
      in_call_recording: {
        data: {
          kind: 'mp3',
          b64_data: VOICE_AUTOMATIC_AUDIO_B64
        }
      }
    };
  }

  try {
    let response = await fetch(`${RECALL_BOTS_ENDPOINT}/`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${RECALL_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ClawPilot-Bridge/1.0'
      },
      body: JSON.stringify(launchBody)
    });
    let data = await response.text();
    if (!response.ok && launchBody.automatic_audio_output) {
      const parsedError = safeParseJson(data);
      const errorText = String(
        typeof parsedError === 'string' ? parsedError : JSON.stringify(parsedError || data)
      );
      if (response.status === 400 && /\bautomatic_audio_output\b|\bextra fields\b|\bunknown field\b|\bnot allowed\b/i.test(errorText)) {
        console.warn('[Launch] automatic_audio_output rejected by Recall API. Retrying launch without voice bootstrap payload.');
        response = await fetch(`${RECALL_BOTS_ENDPOINT}/`, {
          method: 'POST',
          headers: {
            'Authorization': `Token ${RECALL_API_KEY}`,
            'Content-Type': 'application/json',
            'User-Agent': 'ClawPilot-Bridge/1.0'
          },
          body: JSON.stringify(body)
        });
        data = await response.text();
      }
    }
    try {
      const json = JSON.parse(data);
      if (replacedFromBotId) {
        json.replaced_from_bot_id = replacedFromBotId;
      }
      if (response.status >= 200 && response.status < 300 && json?.id) {
        rememberBotSession(json.id, launchSessionId);
        if (effectiveRouteTarget) {
          rememberBotRouteTarget(json.id, effectiveRouteTarget);
        }
        schedulePrimeOnLaunch(json.id).catch((err) => {
          console.warn(`[VoiceMVP] prime_on_join launch monitor error bot=${json.id} error=${err.message}`);
        });
        json.meeting_session = normalizeMeetingSessionId(launchSessionId);
        json.routing_target = effectiveRouteTarget || null;
      }
      return res.status(response.status).json(json);
    } catch (e) {
      return res.status(response.status).send(data);
    }
  } catch (err) {
    console.error('Launch error:', err);
    res.status(500).json({ error: err.message });
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
      resetMeetingCanvasForSession(sessionIdFromEvent || (botId !== 'unknown' ? meetingSessionByBotId.get(botId) : null) || activeMeetingSessionId);
      console.log(`[BotReady] ${botId} recording started`);
      if (botId !== 'unknown') {
        maybePrimeVoiceOutputOnJoin(botId).catch((err) => {
          console.warn(`[VoiceMVP] prime_on_join error bot=${botId} error=${err.message}`);
        });
      }
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
        voicePrimedBotIds.delete(botId);
        forgetBotSession(botId);
      }
      console.log(`[BotStatus] ${botId} ended`);
      break;
    case 'bot.fatal':
      if (botId !== 'unknown') {
        meetingStartByBot.delete(botId);
        relativeEpochBaseByBot.delete(botId);
        voicePrimedBotIds.delete(botId);
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
  if (botId) {
    // Fallback path: status webhooks are optional, so ensure prime-on-join still runs.
    maybePrimeVoiceOutputOnJoin(botId).catch((err) => {
      console.warn(`[VoiceMVP] prime_on_join fallback error bot=${botId} error=${err.message}`);
    });
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
          case 'voice_on':
            setVoiceState(true, `voice:${speaker}`);
            break;
          case 'voice_off':
            setVoiceState(false, `voice:${speaker}`);
            break;
          default:
            break;
        }
        await sendToOpenClaw(`[MEETING CONTROL] ${controlCommand.ack}`, { botId });
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
    
    const explicitVoiceTrigger = parseVoiceTrigger(text);
    const shouldHandleVoiceTrigger = Boolean(
      explicitVoiceTrigger && (!isPartial || (VOICE_TRIGGER_ON_PARTIAL && explicitVoiceTrigger.kind === 'direct'))
    );

    // Debug mode: send raw transcript (only final, not partial - too spammy)
    if (!isPartial && !IS_MUTED) {
      sendDebugTranscript(speaker, text, isPartial, { botId });
      appendTranscriptToCanvas(eventSessionId, speaker, text, botId);
    }
    if (!IS_MUTED && shouldHandleVoiceTrigger) {
      maybeSpeakTriggeredLine({ botId, speaker, text, isPartial }).catch((err) => {
        console.error('[VoiceMVP] trigger handler failed:', err.message);
      });
    }
    
    const force = !isPartial && hasHighValueCue(text);
    if (!isPartial || REACT_ON_PARTIAL) {
      if (explicitVoiceTrigger && !isPartial) {
        console.log('[VoiceMVP] explicit trigger detected; skipping text reaction for this line.');
        return;
      }
      await maybeReact({ webhookReceivedAtMs: nowMs, speechToWebhookMs: speechEndToWebhookMs, botId, isPartial, force });
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
    contextKey: `${isPartial ? 'partial' : 'final'}:${context}`,
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
    const injectMs = await sendToOpenClaw(
      `[MEETING TRANSCRIPT - Active copilot for meeting host]\n\n${candidate.context}\n\n---\nYou are a live meeting copilot coaching the host.\nReturn plain text only (no numbering, bullets, labels, or quotes).\nWrite one short interruption-worthy suggestion the host can say next.\nOptional: add one short follow-up question in the same message.\nKeep total under 32 words, concrete, and conversational.\nDo not mention setup, configuration, API keys, environment files, credentials, quotas, or tooling.`,
      { botId: candidate.meta.botId }
    );
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
  const routeTarget = resolveRouteTarget(options.routeTarget, options.botId);
  const routeText = formatRouteText(routeTarget, 'wake');
  const text = `[MEETING TRANSCRIPT]\n${message}`;
  let direct = null;
  try {
    // FastInject should go through OpenClaw hooks so the agent can respond.
    // Keep direct-delivery here only for Discord, where hook-deliver is known unreliable.
    const allowDirectForFastInject = routeTarget?.channel === 'discord';
    if (allowDirectForFastInject) {
      direct = await tryDirectDelivery(routeTarget, text);
    } else {
      direct = { considered: false, attempted: false, delivered: false, result: null, reason: 'disabled_for_channel' };
    }
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
app.post('/meetverbose/on', (req, res) => {
  const state = setMeetVerboseState(true, 'http:/meetverbose/on');
  res.json({ ...state, message: 'Raw transcript mirror ON (active chat channel)' });
});

app.post('/meetverbose/off', (req, res) => {
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

// Voice mode toggle endpoints
app.post('/voice/on', (req, res) => {
  const state = setVoiceState(true, 'http:/voice/on');
  res.json({
    ...state,
    configured: voiceConfigured(),
    message: 'Meeting voice ON (explicit trigger only)'
  });
});

app.post('/voice/off', (req, res) => {
  const state = setVoiceState(false, 'http:/voice/off');
  res.json({
    ...state,
    configured: voiceConfigured(),
    message: 'Meeting voice OFF'
  });
});

app.get('/voice', (req, res) => {
  res.json({
    enabled: VOICE_ENABLED,
    configured: voiceConfigured(),
    provider: VOICE_PROVIDER,
    automatic_audio_output: VOICE_AUTOMATIC_AUDIO_OUTPUT,
    automatic_audio_payload_source: VOICE_AUTOMATIC_AUDIO_SOURCE,
    require_wake: VOICE_REQUIRE_WAKE,
    trigger_on_partial: VOICE_TRIGGER_ON_PARTIAL,
    wake_names: VOICE_WAKE_NAMES,
    cooldown_ms: VOICE_COOLDOWN_MS,
    min_silence_ms: VOICE_MIN_SILENCE_MS,
    max_chars: VOICE_MAX_CHARS,
    mirror_to_chat: VOICE_MIRROR_TO_CHAT
  });
});

app.get('/voice/debug', (req, res) => {
  res.json({
    voice_enabled: VOICE_ENABLED,
    voice_configured: voiceConfigured(),
    cooldown_ms: VOICE_COOLDOWN_MS,
    last: lastVoiceDebug,
    prime: lastPrimeDebug
  });
});

// ============ MEETING CANVAS ============
const meeting = require('./meeting-page.js');
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
app.get('/meeting', (req, res) => {
  if (!req.query?.session && activeMeetingSessionId && activeMeetingSessionId !== 'default') {
    return res.redirect(302, `/meeting?session=${encodeURIComponent(activeMeetingSessionId)}`);
  }
  res.setHeader('Content-Type', 'text/html');
  res.send(meeting.meetingHTML);
});

// SSE stream for real-time updates
app.get('/meeting/stream', (req, res) => {
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
app.get('/meeting/state', (req, res) => {
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
  console.log(`[OpenClawHook] token=${OPENCLAW_HOOK_TOKEN ? 'set' : 'missing'} url_source=${OPENCLAW_HOOK_URL_SOURCE} token_source=${OPENCLAW_HOOK_TOKEN_SOURCE}`);
  console.log(`[VoiceMVP] enabled=${VOICE_ENABLED} configured=${voiceConfigured()} provider=${VOICE_PROVIDER} require_wake=${VOICE_REQUIRE_WAKE} trigger_on_partial=${VOICE_TRIGGER_ON_PARTIAL} wake_names=${VOICE_WAKE_NAMES.join(',')}`);
  if (!OPENCLAW_HOOK_TOKEN) {
    console.warn(`[OpenClawHook] token missing. Configure hooks.token in ${OPENCLAW_HOOK_DEFAULTS.configPath}`);
  }
});
