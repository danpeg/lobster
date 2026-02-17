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
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    const portRaw = Number(cfg?.gateway?.port);
    const gatewayPort = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 18789;
    const hooksPathRaw = typeof cfg?.hooks?.path === 'string' ? cfg.hooks.path.trim() : '';
    const hooksPathWithSlash = hooksPathRaw ? (hooksPathRaw.startsWith('/') ? hooksPathRaw : `/${hooksPathRaw}`) : '/hooks';
    const hooksPath = (hooksPathWithSlash.length > 1 ? hooksPathWithSlash.replace(/\/+$/, '') : hooksPathWithSlash) || '/hooks';
    const hookToken = typeof cfg?.hooks?.token === 'string' ? cfg.hooks.token.trim() : '';
    return {
      hookUrl: `http://127.0.0.1:${gatewayPort}${hooksPath}/wake`,
      hookToken,
      configPath
    };
  } catch {
    return {
      hookUrl: '',
      hookToken: '',
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
const OPENCLAW_HOOK_URL = process.env.OPENCLAW_HOOK_URL || OPENCLAW_HOOK_DEFAULTS.hookUrl || 'http://127.0.0.1:18789/hooks/wake';
const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || OPENCLAW_HOOK_DEFAULTS.hookToken || '';
const OPENCLAW_HOOK_URL_SOURCE = process.env.OPENCLAW_HOOK_URL ? 'env' : (OPENCLAW_HOOK_DEFAULTS.hookUrl ? 'openclaw.json' : 'builtin-default');
const OPENCLAW_HOOK_TOKEN_SOURCE = process.env.OPENCLAW_HOOK_TOKEN ? 'env' : (OPENCLAW_HOOK_DEFAULTS.hookToken ? 'openclaw.json' : 'missing');
const REPLACE_ACTIVE_ON_DUPLICATE = process.env.REPLACE_ACTIVE_ON_DUPLICATE !== 'false';
const BOT_REPLACE_WAIT_TIMEOUT_MS = Number(process.env.BOT_REPLACE_WAIT_TIMEOUT_MS || 45000);
const BOT_REPLACE_POLL_MS = Number(process.env.BOT_REPLACE_POLL_MS || 1500);
const MEETING_TRANSCRIPT_TO_CANVAS = process.env.MEETING_TRANSCRIPT_TO_CANVAS !== 'false';
const MEETING_MIRROR_TO_DEFAULT = process.env.MEETING_MIRROR_TO_DEFAULT !== 'false';
const MEETING_TRANSCRIPT_MAX_CHARS = Number(process.env.MEETING_TRANSCRIPT_MAX_CHARS || 360);

// Optional Telegram bridge settings for debug/typing feedback
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DEBUG_MIRROR_TELEGRAM = parseBooleanLike(process.env.DEBUG_MIRROR_TELEGRAM, false);
const CONTROL_SPEAKER_REGEX = process.env.CONTROL_SPEAKER_REGEX || '';

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
  try {
    if (!OPENCLAW_HOOK_TOKEN) {
      console.error('[VerboseMirror] OPENCLAW_HOOK_TOKEN is required.');
      return null;
    }
    const routeTarget = resolveRouteTarget(options.routeTarget, options.botId);

    const payload = {
      message: `[MEETVERBOSE MIRROR]\nReply with exactly this line and nothing else:\n${line}`,
      name: 'ClawPilot Verbose',
      wakeMode: 'now',
      deliver: true
    };
    if (routeTarget?.channel) payload.channel = routeTarget.channel;
    if (routeTarget?.to) payload.to = routeTarget.to;

    const response = await fetch(OPENCLAW_AGENT_HOOK_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENCLAW_HOOK_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      result = { ok: response.ok, raw };
    }
    const elapsed = Date.now() - sendStart;
    const routeText = routeTarget ? `${routeTarget.channel}:${routeTarget.to}` : 'last';
    console.log(`[VerboseMirror] ${elapsed}ms - ${response.ok ? "accepted" : "failed"} route=${routeText}`);
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
const PROACTIVITY_LEVEL = String(process.env.PROACTIVITY_LEVEL || 'normal').toLowerCase();
const PROACTIVITY_PRESETS = {
  low: { reactionCooldownMs: 4200, partialDebounceMs: 5200, minNewWords: 20, partialMinNewWords: 18, partialContextWindow: 8, finalContextWindow: 10 },
  normal: { reactionCooldownMs: 2400, partialDebounceMs: 3200, minNewWords: 14, partialMinNewWords: 12, partialContextWindow: 10, finalContextWindow: 12 },
  high: { reactionCooldownMs: 1100, partialDebounceMs: 1800, minNewWords: 8, partialMinNewWords: 6, partialContextWindow: 12, finalContextWindow: 14 }
};
const selectedProactivity = PROACTIVITY_PRESETS[PROACTIVITY_LEVEL] || PROACTIVITY_PRESETS.normal;
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
    
    // Debug mode: send raw transcript (only final, not partial - too spammy)
    if (!isPartial && !IS_MUTED) {
      sendDebugTranscript(speaker, text, isPartial, { botId });
      appendTranscriptToCanvas(eventSessionId, speaker, text, botId);
    }
    
    const force = !isPartial && hasHighValueCue(text);
    if (!isPartial || REACT_ON_PARTIAL) {
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
      `[MEETING TRANSCRIPT - Active copilot for meeting host]\n\n${candidate.context}\n\n---\nYou are a live meeting copilot coaching the host.\nReturn plain text only (no numbering, bullets, labels, or quotes).\nWrite one short interruption-worthy suggestion the host can say next.\nOptional: add one short follow-up question in the same message.\nKeep total under 32 words, concrete, and conversational.`,
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
  try {
    if (!OPENCLAW_HOOK_TOKEN) {
      console.error('[FastInject] OPENCLAW_HOOK_TOKEN is required.');
      return null;
    }
    const routeTarget = resolveRouteTarget(options.routeTarget, options.botId);
    const text = `[MEETING TRANSCRIPT]\n${message}`;
    const headers = {
      "Authorization": `Bearer ${OPENCLAW_HOOK_TOKEN}`,
      "Content-Type": "application/json"
    };
    let response;
    if (routeTarget?.channel && routeTarget?.to) {
      response = await fetch(OPENCLAW_AGENT_HOOK_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: text,
          name: 'ClawPilot Copilot',
          wakeMode: 'now',
          deliver: true,
          channel: routeTarget.channel,
          to: routeTarget.to
        })
      });
    } else {
      response = await fetch(OPENCLAW_HOOK_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ text, mode: "now" })
      });
    }
    const raw = await response.text();
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      result = { ok: response.ok, raw };
    }
    const elapsed = Date.now() - sendStart;
    const routeText = routeTarget ? `${routeTarget.channel}:${routeTarget.to}` : 'wake';
    console.log(`[FastInject] ${elapsed}ms - ${response.ok ? "success" : "failed"} route=${routeText}`);
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
  if (!OPENCLAW_HOOK_TOKEN) {
    console.warn(`[OpenClawHook] token missing. Set OPENCLAW_HOOK_TOKEN or configure hooks.token in ${OPENCLAW_HOOK_DEFAULTS.configPath}`);
  }
});
