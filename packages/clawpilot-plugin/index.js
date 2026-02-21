import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'clawpilot';
const DEFAULT_BRIDGE_HOST = '127.0.0.1';
const DEFAULT_BRIDGE_PORT = 3001;
const DEFAULT_BRIDGE_URL = `http://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`;
const DEFAULT_MANAGED_HEALTH_TIMEOUT_MS = 25_000;
const DEFAULT_MANAGED_STOP_TIMEOUT_MS = 7_000;
const DEFAULT_INSTALL_RECOVERY_MAX_ATTEMPTS = 3;
const DEFAULT_INSTALL_RECOVERY_BACKOFF_MS = 1_200;
const BRIDGE_HEALTH_POLL_MS = 900;
const BRIDGE_RUNTIME_ID = 'clawpilot-bridge';
const MANAGED_STATE_DIR_NAME = 'clawpilot';
const MANAGED_STATE_FILE_NAME = 'managed-bridge-state.json';
const MANAGED_BRIDGE_STATE_FILE_NAME = 'bridge-session-state.json';
const TAILSCALE_SIGNUP_URL = 'https://tailscale.com/';
const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
const TAILSCALE_CANDIDATES = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
];
const RECALL_API_BASE_CANDIDATES = [
  'https://us-east-1.recall.ai',
  'https://eu-central-1.recall.ai',
  'https://us-west-2.recall.ai',
  'https://ap-southeast-1.recall.ai',
];
const CLAWPILOT_COMMAND_ALIASES = ['clawpiolt', 'clawpilto', 'clawpliot', 'clawpilo', 'clwpilot'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BRIDGE_RUNTIME_DIR = path.join(__dirname, 'bridge-runtime');
const BRIDGE_RUNTIME_ENTRY = path.join(BRIDGE_RUNTIME_DIR, 'server.js');
const BRIDGE_RUNTIME_PROMPT_PATH = path.join(BRIDGE_RUNTIME_DIR, 'prompts', 'lobster.md');
const HUMAN_FIRST_NAME_BY_ROUTE = new Map();
const AUTO_JOIN_REPLY_BY_ROUTE = new Map();
const AUTO_JOIN_REPLY_TTL_MS = 8_000;
const MANAGED_BRIDGE_RUNTIME = {
  serviceContext: null,
  child: null,
  healthUrl: DEFAULT_BRIDGE_URL,
};
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
  'recallApiBase',
  'managedBridgeEnabled',
  'managedBridgeHost',
  'managedBridgePort',
  'managedBridgeHealthTimeoutMs',
  'managedBridgeStopTimeoutMs',
  'installRecoveryMaxAttempts',
  'installRecoveryBackoffMs',
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

function toPositiveInteger(value, fallback, min = 1, max = 300_000) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const normalized = Math.round(num);
  if (normalized < min) return fallback;
  if (normalized > max) return max;
  return normalized;
}

function normalizeRecallApiBase(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return '';
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
  } catch {
    return '';
  }
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
  const pluginEntry = cloneObject(cfg?.plugins?.entries?.[PLUGIN_ID]);
  const { legacyConfig } = splitPluginEntryAndLegacyConfig(pluginEntry);
  const pluginCfg = { ...legacyConfig, ...cloneObject(pluginEntry.config) };
  const managedBridgeHost = String(pluginCfg.managedBridgeHost || DEFAULT_BRIDGE_HOST).trim() || DEFAULT_BRIDGE_HOST;
  const managedBridgePort = toPositiveInteger(pluginCfg.managedBridgePort, DEFAULT_BRIDGE_PORT, 1, 65535);
  const managedBridgeEnabled = pluginCfg.managedBridgeEnabled !== false;
  const managedBridgeHealthTimeoutMs = toPositiveInteger(
    pluginCfg.managedBridgeHealthTimeoutMs,
    DEFAULT_MANAGED_HEALTH_TIMEOUT_MS,
    2_000,
    120_000,
  );
  const managedBridgeStopTimeoutMs = toPositiveInteger(
    pluginCfg.managedBridgeStopTimeoutMs,
    DEFAULT_MANAGED_STOP_TIMEOUT_MS,
    1_000,
    60_000,
  );
  const installRecoveryMaxAttempts = toPositiveInteger(
    pluginCfg.installRecoveryMaxAttempts,
    DEFAULT_INSTALL_RECOVERY_MAX_ATTEMPTS,
    1,
    6,
  );
  const installRecoveryBackoffMs = toPositiveInteger(
    pluginCfg.installRecoveryBackoffMs,
    DEFAULT_INSTALL_RECOVERY_BACKOFF_MS,
    100,
    15_000,
  );
  const localManagedBridgeUrl = `http://${managedBridgeHost}:${managedBridgePort}`;
  const allowRemoteBridge = Boolean(pluginCfg.allowRemoteBridge);
  const bridgeBaseUrl = normalizeBridgeBaseUrl(pluginCfg.bridgeBaseUrl || localManagedBridgeUrl, allowRemoteBridge);
  const bridgeToken = pluginCfg.bridgeToken || '';
  const recallApiBase = normalizeRecallApiBase(pluginCfg.recallApiBase);
  const teamAgent = Boolean(pluginCfg.teamAgent);
  const autoJoinMeetingLinks = pluginCfg.autoJoinMeetingLinks !== false;
  const autoJoinReplaceActive = Boolean(pluginCfg.autoJoinReplaceActive);
  const manualJoinReplaceActive = pluginCfg.manualJoinReplaceActive !== false;
  const blockLegacyMeetingLaunchScripts = pluginCfg.blockLegacyMeetingLaunchScripts !== false;
  return {
    bridgeBaseUrl,
    bridgeToken,
    recallApiBase,
    managedBridgeEnabled,
    managedBridgeHost,
    managedBridgePort,
    managedBridgeHealthTimeoutMs,
    managedBridgeStopTimeoutMs,
    installRecoveryMaxAttempts,
    installRecoveryBackoffMs,
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

function isHttpsTsNetUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.ts.net');
  } catch {
    return false;
  }
}

function isLoopbackBridgeBaseUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findFirstTsNetUrl(value) {
  if (typeof value === 'string') {
    const match = value.match(/https:\/\/[A-Za-z0-9.-]+\.ts\.net(?:\/[^\s"'`)]*)?/i);
    return match ? normalizeUrlNoTrailingSlash(match[0]) : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstTsNetUrl(item);
      if (found) return found;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findFirstTsNetUrl(item);
      if (found) return found;
    }
  }
  return '';
}

function extractFirstHttpUrl(text) {
  const match = String(text || '').match(/https:\/\/[^\s"'`]+/i);
  return match ? match[0] : '';
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactSensitiveText(value) {
  const text = String(value || '');
  if (!text) return '';
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer ***redacted***')
    .replace(/(BRIDGE_API_TOKEN=)[^\s"'`]+/gi, '$1***redacted***')
    .replace(/(RECALL_API_KEY=)[^\s"'`]+/gi, '$1***redacted***')
    .replace(/(WEBHOOK_SECRET=)[^\s"'`]+/gi, '$1***redacted***');
}

function getManagedStateRootDir() {
  const stateDir = MANAGED_BRIDGE_RUNTIME.serviceContext?.stateDir || path.join(os.homedir(), '.openclaw', 'state');
  return path.join(stateDir, MANAGED_STATE_DIR_NAME);
}

function getManagedStateFilePath() {
  return path.join(getManagedStateRootDir(), MANAGED_STATE_FILE_NAME);
}

function getManagedBridgeStateFilePath() {
  return path.join(getManagedStateRootDir(), MANAGED_BRIDGE_STATE_FILE_NAME);
}

function sanitizeManagedState(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    bridgeToken: String(input.bridgeToken || '').trim(),
    recallApiBase: normalizeRecallApiBase(input.recallApiBase),
    bridgePid: Number.isFinite(Number(input.bridgePid)) ? Number(input.bridgePid) : 0,
    bridgeBaseUrl: normalizeUrlNoTrailingSlash(String(input.bridgeBaseUrl || '')),
    updatedAt: String(input.updatedAt || '').trim(),
  };
}

async function readManagedState() {
  const filePath = getManagedStateFilePath();
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return sanitizeManagedState(tryParseJson(raw) || {});
  } catch {
    return sanitizeManagedState({});
  }
}

async function writeManagedState(nextState) {
  const root = getManagedStateRootDir();
  const filePath = getManagedStateFilePath();
  await fsp.mkdir(root, { recursive: true });
  const payload = sanitizeManagedState({
    ...nextState,
    updatedAt: new Date().toISOString(),
  });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function generateSecureBridgeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isPidRunning(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopPidGracefully(pid, timeoutMs = DEFAULT_MANAGED_STOP_TIMEOUT_MS) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return;
  if (!isPidRunning(numericPid)) return;
  try {
    process.kill(numericPid, 'SIGTERM');
  } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(numericPid)) return;
    await sleep(200);
  }
  try {
    process.kill(numericPid, 'SIGKILL');
  } catch {}
}

async function ensureBridgeHealthReady(baseUrl, timeoutMs = DEFAULT_MANAGED_HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = { ok: false, reason: 'not started', code: 0, url: '' };
  while (Date.now() < deadline) {
    lastProbe = await probeBridgeHealth(baseUrl);
    if (lastProbe.ok) return { ok: true, probe: lastProbe };
    await sleep(BRIDGE_HEALTH_POLL_MS);
  }
  return { ok: false, probe: lastProbe };
}

async function readEnvValue(api, key) {
  const direct = String(process.env[key] || '').trim();
  if (direct) return direct;
  const result = await runSystemCommand(api, ['printenv', key]);
  if (!result.ok) return '';
  return String(result.stdout || '').trim();
}

async function probeRecallApiBase(baseUrl) {
  const normalized = normalizeRecallApiBase(baseUrl);
  if (!normalized) return { ok: false, code: 0 };
  try {
    const res = await fetchWithTimeout(`${normalized}/api/v1/bot?page_size=1`, { method: 'GET' }, 6_000);
    const code = Number(res.status || 0);
    await res.text();
    return { ok: code === 200 || code === 401 || code === 403, code };
  } catch {
    return { ok: false, code: 0 };
  }
}

async function resolveRecallApiBase(api, cfg, options = {}) {
  const managedState = await readManagedState();
  const configCandidate = normalizeRecallApiBase(cfg?.recallApiBase);
  if (configCandidate) return { ok: true, base: configCandidate, source: 'plugin config' };

  const stateCandidate = normalizeRecallApiBase(options.stateOverride || managedState.recallApiBase);
  if (stateCandidate) return { ok: true, base: stateCandidate, source: 'managed state' };

  const envCandidate = normalizeRecallApiBase(await readEnvValue(api, 'RECALL_API_BASE'));
  if (envCandidate) return { ok: true, base: envCandidate, source: 'environment' };

  if (options.skipProbe) {
    return { ok: false, base: '', source: '', reason: 'missing RECALL_API_BASE in config/state/env' };
  }

  const successful = [];
  for (const candidate of RECALL_API_BASE_CANDIDATES) {
    const probe = await probeRecallApiBase(candidate);
    if (probe.ok) {
      successful.push(candidate);
    }
  }

  if (successful.length === 1) {
    return { ok: true, base: successful[0], source: 'region probe' };
  }
  if (successful.length > 1) {
    return {
      ok: false,
      base: '',
      source: '',
      reason: 'multiple Recall regions responded; set RECALL_API_BASE explicitly to your workspace region',
    };
  }
  return {
    ok: false,
    base: '',
    source: '',
    reason: 'no Recall region endpoint responded; set RECALL_API_BASE explicitly',
  };
}

async function resolveTailscaleBinary(api) {
  for (const candidate of TAILSCALE_CANDIDATES) {
    if (candidate.startsWith('/') && !fs.existsSync(candidate)) continue;
    const result = await runSystemCommand(api, [candidate, 'version'], 8_000);
    if (result.ok) return { ok: true, bin: candidate };
  }
  return { ok: false, bin: '', reason: 'tailscale binary not found in PATH, app bundle, or Homebrew paths' };
}

async function runTailscale(api, tailscaleBin, args, timeoutMs = 12_000) {
  return runSystemCommand(api, [tailscaleBin, ...args], timeoutMs);
}

async function discoverFunnelUrl(api, tailscaleBin) {
  const statusJson = await runTailscale(api, tailscaleBin, ['funnel', 'status', '--json']);
  if (statusJson.ok) {
    const parsed = tryParseJson(statusJson.stdout);
    const fromJson = findFirstTsNetUrl(parsed);
    if (fromJson) return fromJson;
    const fromText = findFirstTsNetUrl(statusJson.combined);
    if (fromText) return fromText;
  }
  const statusText = await runTailscale(api, tailscaleBin, ['funnel', 'status']);
  if (statusText.ok) {
    const fromText = findFirstTsNetUrl(statusText.combined);
    if (fromText) return fromText;
  }
  return '';
}

async function syncPluginBridgeToken(api, token) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) return '';
  const current = loadBridgeConfig(api);
  if (current.bridgeToken === cleanToken) return cleanToken;
  await updateClawpilotPluginConfig(api, { bridgeToken: cleanToken });
  return cleanToken;
}

async function ensureBridgeToken(api) {
  const cfg = loadBridgeConfig(api);
  if (cfg.bridgeToken) {
    const state = await writeManagedState({ ...(await readManagedState()), bridgeToken: cfg.bridgeToken });
    return state.bridgeToken;
  }
  const state = await readManagedState();
  if (state.bridgeToken) {
    await syncPluginBridgeToken(api, state.bridgeToken);
    return state.bridgeToken;
  }
  const generated = generateSecureBridgeToken();
  await writeManagedState({ ...state, bridgeToken: generated });
  await syncPluginBridgeToken(api, generated);
  return generated;
}

async function stopManagedBridgeRuntime(api, cfg) {
  if (MANAGED_BRIDGE_RUNTIME.child && !MANAGED_BRIDGE_RUNTIME.child.killed) {
    const child = MANAGED_BRIDGE_RUNTIME.child;
    child.removeAllListeners('exit');
    try {
      child.kill('SIGTERM');
    } catch {}
    const deadline = Date.now() + cfg.managedBridgeStopTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      await sleep(150);
    }
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    MANAGED_BRIDGE_RUNTIME.child = null;
  }

  const state = await readManagedState();
  if (state.bridgePid && isPidRunning(state.bridgePid)) {
    await stopPidGracefully(state.bridgePid, cfg.managedBridgeStopTimeoutMs);
  }
  await writeManagedState({ ...state, bridgePid: 0 });
  api.logger.info('[ClawPilot] managed bridge stopped');
}

async function startManagedBridgeRuntime(api, cfg) {
  const state = await readManagedState();
  if (state.bridgePid && isPidRunning(state.bridgePid)) {
    await stopPidGracefully(state.bridgePid, cfg.managedBridgeStopTimeoutMs);
  }
  if (!fs.existsSync(BRIDGE_RUNTIME_ENTRY)) {
    throw new Error(`Bundled bridge runtime is missing: ${BRIDGE_RUNTIME_ENTRY}`);
  }

  const recallResolution = await resolveRecallApiBase(api, cfg);
  const bridgeToken = await ensureBridgeToken(api);
  const localBaseUrl = `http://${cfg.managedBridgeHost}:${cfg.managedBridgePort}`;
  const env = {
    ...process.env,
    HOST: cfg.managedBridgeHost,
    PORT: String(cfg.managedBridgePort),
    BRIDGE_API_TOKEN: bridgeToken,
    BRIDGE_STATE_FILE: getManagedBridgeStateFilePath(),
    LOBSTER_PROMPT_PATH: BRIDGE_RUNTIME_PROMPT_PATH,
  };
  if (recallResolution.ok) {
    env.RECALL_API_BASE = recallResolution.base;
  }

  const child = spawn(process.execPath, [BRIDGE_RUNTIME_ENTRY], {
    cwd: BRIDGE_RUNTIME_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk) => {
    const line = redactSensitiveText(String(chunk || '').trim());
    if (line) api.logger.info(`[ClawPilotBridge] ${line.slice(0, 600)}`);
  });
  child.stderr?.on('data', (chunk) => {
    const line = redactSensitiveText(String(chunk || '').trim());
    if (line) api.logger.warn(`[ClawPilotBridge] ${line.slice(0, 600)}`);
  });
  child.on('exit', async () => {
    MANAGED_BRIDGE_RUNTIME.child = null;
    const nextState = await readManagedState();
    await writeManagedState({ ...nextState, bridgePid: 0 });
  });

  const ready = await ensureBridgeHealthReady(localBaseUrl, cfg.managedBridgeHealthTimeoutMs);
  if (!ready.ok) {
    try {
      child.kill('SIGKILL');
    } catch {}
    throw new Error(`managed bridge did not become healthy (${ready.probe.reason || `HTTP ${ready.probe.code}`})`);
  }

  MANAGED_BRIDGE_RUNTIME.child = child;
  MANAGED_BRIDGE_RUNTIME.healthUrl = localBaseUrl;

  await writeManagedState({
    ...state,
    bridgePid: child.pid || 0,
    bridgeToken,
    bridgeBaseUrl: localBaseUrl,
    recallApiBase: recallResolution.ok ? recallResolution.base : state.recallApiBase,
  });
  api.logger.info(`[ClawPilot] managed bridge ready at ${localBaseUrl}`);
}

async function ensureManagedBridgeRunning(api, cfg) {
  if (!cfg.managedBridgeEnabled) return;
  if (MANAGED_BRIDGE_RUNTIME.child && MANAGED_BRIDGE_RUNTIME.child.exitCode === null) {
    const healthy = await probeBridgeHealth(`http://${cfg.managedBridgeHost}:${cfg.managedBridgePort}`);
    if (healthy.ok) return;
  }
  await startManagedBridgeRuntime(api, cfg);
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
    return { ok: false, code: 0, url: '', reason: 'invalid base URL' };
  }
  const healthUrl = `${normalizedBase}/health`;
  try {
    const res = await fetchWithTimeout(healthUrl, { method: 'GET' });
    const code = Number(res.status || 0);
    const raw = await res.text();
    const body = tryParseJson(raw);
    const bodyOk = body && body.status === 'ok' && body.hook && body.prompt;
    return { ok: code === 200 && Boolean(bodyOk), code, url: healthUrl, reason: bodyOk ? '' : 'unexpected health body' };
  } catch (err) {
    return { ok: false, code: 0, url: healthUrl, reason: tailOutput(err?.message || err) || 'request failed' };
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

function buildTailscalePrimerLines(setupCommand = '/clawpilot setup') {
  return [
    'Why ClawPilot uses Tailscale Funnel:',
    '- It gives each user a private, stable HTTPS endpoint (`*.ts.net`) without opening random public ports.',
    '- Funnel keeps webhook routing predictable and safer for non-dev setup.',
    '',
    'How to sign up for Tailscale:',
    `1) Create account: ${TAILSCALE_SIGNUP_URL}`,
    `2) Install app: ${TAILSCALE_DOWNLOAD_URL}`,
    `3) Sign in once on this OpenClaw host, then rerun ${setupCommand}.`,
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
  if (text.includes('recall_api_base')) return true;
  if (text.includes('recall region')) return true;
  if (text.includes('tailscale')) return true;
  if (text.includes('funnel')) return true;
  return false;
}

async function runSetupAssistant(api, options = {}) {
  const setupCommand = '/clawpilot install';
  const lines = [
    'ClawPilot install finalizer',
    'Deterministic greedy recovery is enabled (bounded retries, no secret output).',
    '',
    ...buildTailscalePrimerLines(setupCommand),
    '',
  ];
  const totalSteps = 10;
  let step = 0;

  const failStep = (action, remediationLines, detailLines = []) => {
    lines.push(`Step ${step}/${totalSteps}: ${action} -> FAILED`);
    for (const detail of detailLines) {
      if (detail) lines.push(detail);
    }
    for (const remediation of remediationLines) {
      if (remediation) lines.push(remediation);
    }
    return lines.join('\n');
  };
  const okStep = (action, detail = '') => {
    lines.push(`Step ${step}/${totalSteps}: ${action} -> OK${detail ? ` (${detail})` : ''}`);
  };

  const cfg = loadBridgeConfig(api);
  const maxAttempts = cfg.installRecoveryMaxAttempts;
  const backoffMs = cfg.installRecoveryBackoffMs;
  let funnelUrl = '';

  step += 1;
  okStep('read plugin config', `bridge=${cfg.bridgeBaseUrl}`);

  step += 1;
  const recallResolution = await resolveRecallApiBase(api, cfg);
  if (!recallResolution.ok) {
    return failStep(
      'resolve RECALL_API_BASE',
      [
        'Set RECALL_API_BASE to your Recall workspace region endpoint, then rerun /clawpilot install.',
        'Example: openclaw config set plugins.entries.clawpilot.config.recallApiBase "https://<region>.recall.ai"',
      ],
      [recallResolution.reason || 'Recall API base could not be resolved from config/state/env/probe.'],
    );
  }
  await updateClawpilotPluginConfig(api, { recallApiBase: recallResolution.base });
  await writeManagedState({ ...(await readManagedState()), recallApiBase: recallResolution.base });
  okStep('resolve RECALL_API_BASE', `${recallResolution.base} via ${recallResolution.source}`);

  step += 1;
  try {
    await ensureManagedBridgeRunning(api, cfg);
    okStep('start managed bridge service');
  } catch (err) {
    return failStep(
      'start managed bridge service',
      [
        'Ensure bundled bridge runtime files exist and required env vars are set (RECALL_API_KEY, WEBHOOK_SECRET, WEBHOOK_BASE_URL).',
        'Then rerun /clawpilot install.',
      ],
      [tailOutput(redactSensitiveText(err?.message || err))],
    );
  }

  step += 1;
  const tailscaleResolution = await resolveTailscaleBinary(api);
  if (!tailscaleResolution.ok) {
    return failStep(
      'resolve tailscale binary',
      [
        'Install/sign in to Tailscale, then rerun /clawpilot install.',
        `macOS app path checked: ${TAILSCALE_CANDIDATES[1]}`,
      ],
      [tailscaleResolution.reason],
    );
  }
  const tailscaleBin = tailscaleResolution.bin;
  okStep('resolve tailscale binary', tailscaleBin);

  step += 1;
  let tailscaleAuthed = false;
  let tailscaleAuthUrl = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await runTailscale(api, tailscaleBin, ['status', '--json']);
    if (status.ok) {
      const parsed = tryParseJson(status.stdout);
      if (String(parsed?.BackendState || '').toLowerCase() === 'running') {
        tailscaleAuthed = true;
        break;
      }
    }
    const up = await runTailscale(api, tailscaleBin, ['up'], 35_000);
    const maybeUrl = extractFirstHttpUrl(up.combined);
    if (maybeUrl) tailscaleAuthUrl = maybeUrl;
    if (attempt < maxAttempts) await sleep(backoffMs);
  }
  if (!tailscaleAuthed) {
    return failStep(
      'tailscale auth state',
      [
        tailscaleAuthUrl
          ? `Open this link, complete login, then rerun /clawpilot install: ${tailscaleAuthUrl}`
          : 'Open Tailscale on this host, sign in, then rerun /clawpilot install.',
      ],
      ['Could not confirm BackendState=Running after bounded retries.'],
    );
  }
  okStep('tailscale auth state');

  step += 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    funnelUrl = await discoverFunnelUrl(api, tailscaleBin);
    if (funnelUrl && isHttpsTsNetUrl(funnelUrl)) break;
    await runTailscale(api, tailscaleBin, ['funnel', String(cfg.managedBridgePort)], 20_000);
    if (attempt < maxAttempts) await sleep(backoffMs);
  }
  if (!funnelUrl || !isHttpsTsNetUrl(funnelUrl)) {
    return failStep(
      'discover tailscale funnel URL',
      [
        `Enable Funnel for port ${cfg.managedBridgePort} then rerun /clawpilot install.`,
        `Try: ${tailscaleBin} funnel ${cfg.managedBridgePort}`,
      ],
      ['Expected a valid https://*.ts.net funnel URL.'],
    );
  }
  okStep('discover tailscale funnel URL', funnelUrl);

  step += 1;
  const localBridgeUrl = `http://${cfg.managedBridgeHost}:${cfg.managedBridgePort}`;
  let localHealth = { ok: false, reason: '', code: 0 };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    localHealth = await probeBridgeHealth(localBridgeUrl);
    if (localHealth.ok) break;
    try {
      await ensureManagedBridgeRunning(api, cfg);
    } catch {}
    if (attempt < maxAttempts) await sleep(backoffMs);
  }
  if (!localHealth.ok) {
    return failStep(
      'local bridge health check',
      ['Managed bridge did not become healthy. Restart OpenClaw daemon and rerun /clawpilot install.'],
      [localHealth.reason || `HTTP ${localHealth.code}`],
    );
  }
  okStep('local bridge health check');

  step += 1;
  let publicHealth = { ok: false, reason: '', code: 0 };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    publicHealth = await probeBridgeHealth(funnelUrl);
    if (publicHealth.ok) break;
    await runTailscale(api, tailscaleBin, ['funnel', String(cfg.managedBridgePort)], 20_000);
    if (attempt < maxAttempts) await sleep(backoffMs);
  }
  if (!publicHealth.ok) {
    return failStep(
      'public funnel health check',
      ['Verify Funnel routing to local bridge port and rerun /clawpilot install.'],
      [publicHealth.reason || `HTTP ${publicHealth.code}`],
    );
  }
  okStep('public funnel health check');

  step += 1;
  const bridgeToken = await ensureBridgeToken(api);
  await updateClawpilotPluginConfig(api, {
    bridgeBaseUrl: funnelUrl,
    bridgeToken,
    recallApiBase: recallResolution.base,
  });
  let authAligned = false;
  let authProbe = { unauthCode: 0, authCode: 0, reason: '' };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    authProbe = await probeBridgeAuth(funnelUrl, bridgeToken);
    if (authProbe.unauthCode === 401 && authProbe.authCode === 200) {
      authAligned = true;
      break;
    }
    try {
      await ensureManagedBridgeRunning(api, cfg);
    } catch {}
    if (attempt < maxAttempts) await sleep(backoffMs);
  }
  if (!authAligned) {
    return failStep(
      'bridge auth alignment preflight',
      [
        `Run /clawpilot connect ${funnelUrl} --token <BRIDGE_API_TOKEN> after verifying bridge auth.`,
        'Then rerun /clawpilot install.',
      ],
      [
        `Observed unauth=${authProbe.unauthCode || 0}, auth=${authProbe.authCode || 0}`,
        authProbe.reason ? `Reason: ${tailOutput(redactSensitiveText(authProbe.reason))}` : '',
      ],
    );
  }
  okStep('bridge auth alignment preflight');

  step += 1;
  okStep('final pass/fail');
  lines.push('✅ Install finalizer complete. You can now run /clawpilot status or /clawpilot join.');
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
  const bridgeUrl = parsed.bridgeUrl || current.bridgeBaseUrl;
  const bridgeToken = parsed.bridgeToken || current.bridgeToken;

  if (!bridgeUrl) {
    lines.push('Missing bridge URL.');
    lines.push('Usage: /clawpilot connect https://<your-node>.ts.net --token <BRIDGE_API_TOKEN>');
    return lines.join('\n');
  }
  if (!isHttpsTsNetUrl(bridgeUrl)) {
    lines.push(`Invalid bridge URL: ${bridgeUrl}`);
    lines.push('For supported onboarding, URL must be `https://*.ts.net`.');
    return lines.join('\n');
  }

  lines.push(`Step 1/3: bridge URL accepted (${bridgeUrl})`);
  lines.push(`Step 2/3: bridge token is ${bridgeToken ? 'provided/set' : 'missing'}`);

  await updateClawpilotPluginConfig(api, {
    bridgeBaseUrl: bridgeUrl,
    ...(bridgeToken ? { bridgeToken } : {}),
  });
  lines.push('Step 3/3: saved plugin bridge config');

  const authProbe = await probeBridgeAuth(bridgeUrl, bridgeToken);
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
    lines.push('Run: /clawpilot connect https://<your-node>.ts.net --token <BRIDGE_API_TOKEN>');
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
    '  Alias of /clawpilot install.',
    '  Runs the same deterministic greedy recovery flow.',
    '',
    '/clawpilot connect <bridge_url> --token <BRIDGE_API_TOKEN>',
    '  Save bridge URL/token from chat and validate auth alignment.',
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
    'Common typo aliases are also supported (for example: /clawpiolt).',
    '',
    'Examples:',
    '/clawpilot install',
    '/clawpilot setup',
    '/clawpilot connect https://your-node.ts.net --token <BRIDGE_API_TOKEN>',
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
      'Run /clawpilot install to auto-generate/sync token and revalidate auth.',
      'Or set plugins.entries.clawpilot.config.bridgeToken to match BRIDGE_API_TOKEN, then restart OpenClaw daemon.',
    ].join(' ');
  }
  return [
    'Bridge authentication failed (401): configured plugin bridgeToken was rejected.',
    'Run /clawpilot install to re-sync token and verify preflight.',
    'If needed, re-sync plugins.entries.clawpilot.config.bridgeToken with BRIDGE_API_TOKEN and restart OpenClaw daemon.',
    'For chat-only onboarding, run /clawpilot install.',
  ].join(' ');
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

  let cfg = loadBridgeConfig(api);
  let bridgeBaseUrl = cfg.bridgeBaseUrl;
  let bridgeToken = cfg.bridgeToken;
  const localManagedBridge = cfg.managedBridgeEnabled && isLoopbackBridgeBaseUrl(bridgeBaseUrl);

  if (localManagedBridge) {
    try {
      await ensureManagedBridgeRunning(api, cfg);
    } catch (err) {
      api.logger.warn(`[ClawPilot] managed bridge auto-start failed: ${tailOutput(redactSensitiveText(err?.message || err))}`);
    }
    if (!bridgeToken) {
      bridgeToken = await ensureBridgeToken(api);
    }
  }

  const makeRequest = async (tokenValue) => {
    const headers = { 'Content-Type': 'application/json' };
    if (tokenValue) headers.Authorization = `Bearer ${tokenValue}`;
    const request = { method, headers };
    if (body !== undefined) request.body = JSON.stringify(body);
    return fetchWithTimeout(`${bridgeBaseUrl}${path}`, request, 12_000);
  };

  let res;
  try {
    res = await makeRequest(bridgeToken);
  } catch (err) {
    if (localManagedBridge) {
      try {
        await ensureManagedBridgeRunning(api, cfg);
        res = await makeRequest(bridgeToken);
      } catch {
        const causeCode = err?.cause?.code ? ` (${err.cause.code})` : '';
        throw new Error(
          `Bridge is unreachable at ${bridgeBaseUrl}${path}${causeCode}. Verify bridgeBaseUrl and managed bridge health, then rerun /clawpilot install.`
        );
      }
    } else {
      const causeCode = err?.cause?.code ? ` (${err.cause.code})` : '';
      throw new Error(
        `Bridge is unreachable at ${bridgeBaseUrl}${path}${causeCode}. Verify bridgeBaseUrl, ensure bridge service is running, and confirm Tailscale Funnel points to this bridge (/health). Run /clawpilot install for guided chat onboarding.`
      );
    }
  }

  let text = await res.text();
  let responseBody = text;
  try {
    responseBody = JSON.parse(text);
  } catch {}

  if (res.status === 401 && localManagedBridge) {
    bridgeToken = await ensureBridgeToken(api);
    res = await makeRequest(bridgeToken);
    text = await res.text();
    responseBody = text;
    try {
      responseBody = JSON.parse(text);
    } catch {}
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(buildBridgeUnauthorizedMessage(bridgeToken));
    }
    throw new Error(`Bridge call failed (${res.status}): ${formatBridgeErrorBody(responseBody)}`);
  }
  return responseBody;
}

export default function register(api) {
  api.registerService({
    id: BRIDGE_RUNTIME_ID,
    start: async (serviceContext) => {
      MANAGED_BRIDGE_RUNTIME.serviceContext = serviceContext;
      const cfg = loadBridgeConfig(api);
      if (!cfg.managedBridgeEnabled) {
        api.logger.info('[ClawPilot] managed bridge service disabled by plugin config');
        return;
      }
      await ensureManagedBridgeRunning(api, cfg);
    },
    stop: async () => {
      const cfg = loadBridgeConfig(api);
      await stopManagedBridgeRuntime(api, cfg);
    },
  });

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

  const bridgeActions = new Set([
    'install',
    'setup',
    'connect',
    'status',
    'join',
    'pause',
    'resume',
    'transcript',
    'mode',
    'audience',
    'privacy',
    'reveal',
  ]);

  const clawpilotHandler = async (ctx) => {
    const rawArgs = (ctx.args || '').trim();
    const [rawAction, ...rest] = rawArgs ? rawArgs.split(/\s+/) : ['help'];
    const action = (rawAction || 'help').toLowerCase();
    const actionArgs = rest.join(' ').trim();

    try {
      if (!action || action === 'help') {
        return { text: buildHelpText() };
      }

      if (action === 'setup' || action === 'install') {
        return { text: await runSetupAssistant(api, { mode: 'install' }) };
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
          payload.bot_name = defaultLobsterName || 'Lobster 🦞';
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
          text: ['/clawpilot transcript on', '/clawpilot transcript off'].join('\n'),
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
          return { text: ['/clawpilot audience private', '/clawpilot audience shared'].join('\n') };
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
        text: [`Unknown command: ${action}`, '', buildHelpText()].join('\n'),
      };
    } catch (err) {
      const message = String(err?.message || err || 'unknown error');
      if (bridgeActions.has(action) && isInstallClassBridgeError(message)) {
        try {
          const recovery = await runSetupAssistant(api, { mode: 'install', trigger: action });
          return {
            text: [
              `ClawPilot command failed: ${message}`,
              '',
              'Running greedy install recovery now:',
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
      if (/bridge is unreachable|authentication failed|bridgetoken|tailscale|funnel/i.test(message)) {
        return {
          text: `ClawPilot command failed: ${message}\n\nTry chat-only onboarding:\n/clawpilot install`,
        };
      }
      return { text: `ClawPilot command failed: ${message}` };
    }
  };

  api.registerCommand({
    name: 'clawpilot',
    description: 'Control ClawPilot: help | install | setup | connect | status | join | pause | resume | transcript | mode | audience | privacy | reveal',
    acceptsArgs: true,
    handler: clawpilotHandler,
  });

  for (const alias of CLAWPILOT_COMMAND_ALIASES) {
    api.registerCommand({
      name: alias,
      description: 'Alias for /clawpilot',
      acceptsArgs: true,
      handler: clawpilotHandler,
    });
  }
}
