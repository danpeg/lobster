const fs = require('fs');
const path = require('path');

const FALLBACK_MODE = 'balanced';
const FALLBACK_AUDIENCE = 'private';
const REQUIRED_SECTION = 'BASE_PROMPT';

function normalizeKey(value) {
  return String(value || '').trim();
}

function normalizeName(value, fallback = '') {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return fallback;
  return normalized.slice(0, 120);
}

function normalizeMode(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeAudience(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'shared' ? 'shared' : 'private';
}

function parseSections(raw) {
  const text = String(raw || '');
  const lines = text.split(/\r?\n/);
  const sections = new Map();
  let currentKey = '';
  let bucket = [];

  function commit() {
    if (!currentKey) return;
    sections.set(currentKey, bucket.join('\n').trim());
  }

  for (const line of lines) {
    const header = line.match(/^##\s+(.+?)\s*$/);
    if (header) {
      commit();
      currentKey = normalizeKey(header[1]);
      bucket = [];
      continue;
    }
    if (currentKey) {
      bucket.push(line);
    }
  }
  commit();
  return sections;
}

function readDefaultMode(sections) {
  const raw = sections.get('DEFAULT_MODE') || '';
  const line = raw.split(/\r?\n/, 1)[0] || '';
  return normalizeMode(line) || FALLBACK_MODE;
}

function createPromptManager(options = {}) {
  const promptPath = path.resolve(
    options.promptPath || process.env.LOBSTER_PROMPT_PATH || path.join(__dirname, 'prompts', 'lobster.md')
  );
  let cachedMtimeMs = null;
  let cachedSections = new Map();
  let cachedError = '';

  function loadIfNeeded() {
    try {
      const stat = fs.statSync(promptPath);
      if (cachedMtimeMs !== null && stat.mtimeMs === cachedMtimeMs && cachedSections.size > 0) {
        return;
      }
      const raw = fs.readFileSync(promptPath, 'utf8');
      const parsed = parseSections(raw);
      if (!parsed.get(REQUIRED_SECTION)) {
        throw new Error(`Missing required section: ${REQUIRED_SECTION}`);
      }
      cachedSections = parsed;
      cachedMtimeMs = stat.mtimeMs;
      cachedError = '';
    } catch (error) {
      cachedError = error.message;
    }
  }

  function getSection(key) {
    loadIfNeeded();
    return cachedSections.get(key) || '';
  }

  function getModeBlock(mode) {
    const requested = normalizeMode(mode);
    return getSection(`MODE:${requested}`) || getSection(`MODE:${FALLBACK_MODE}`);
  }

  function getAudienceBlock(audience) {
    const normalized = normalizeAudience(audience);
    return getSection(`AUDIENCE:${normalized}`);
  }

  function getTeamAgentBlock(teamAgent) {
    return getSection(`TEAM_AGENT:${teamAgent ? 'true' : 'false'}`);
  }

  function renderPrompt(input = {}) {
    const copilotName = normalizeName(input.copilotName, 'OpenClaw');
    const meetingContext = String(input.meetingContext || '').trim();
    const mode = normalizeMode(input.mode) || readDefaultMode(cachedSections) || FALLBACK_MODE;
    const audience = normalizeAudience(input.audience || FALLBACK_AUDIENCE);
    const revealBlock = String(input.revealBlock || '').trim() || getSection('REVEAL:default');
    const modeBlock = getModeBlock(mode);
    const audienceBlock = getAudienceBlock(audience);
    const teamAgentBlock = getTeamAgentBlock(Boolean(input.teamAgent));
    const base = getSection(REQUIRED_SECTION);

    if (!base) {
      const fallbackPrompt = [
        `You are ${copilotName}, a live meeting copilot for the host.`,
        'Return concise, actionable coaching.',
        `Mode: ${mode}. Audience: ${audience}.`,
        'Meeting context:',
        meetingContext
      ].join('\n');
      return {
        prompt: fallbackPrompt,
        sourcePath: promptPath,
        usedFallback: true,
        error: cachedError || `Missing ${REQUIRED_SECTION}`
      };
    }

    const rendered = base
      .replaceAll('{{COPILOT_NAME}}', copilotName)
      .replaceAll('{{MEETING_CONTEXT}}', meetingContext)
      .replaceAll('{{ACTIVE_MODE}}', mode)
      .replaceAll('{{ACTIVE_AUDIENCE}}', audience)
      .replaceAll('{{MODE_BLOCK}}', modeBlock)
      .replaceAll('{{AUDIENCE_BLOCK}}', audienceBlock)
      .replaceAll('{{TEAM_AGENT_BLOCK}}', teamAgentBlock)
      .replaceAll('{{REVEAL_BLOCK}}', revealBlock);

    return {
      prompt: rendered,
      sourcePath: promptPath,
      usedFallback: false,
      error: cachedError
    };
  }

  function getAvailableModes() {
    loadIfNeeded();
    const modes = [];
    for (const key of cachedSections.keys()) {
      const match = key.match(/^MODE:(.+)$/);
      if (match?.[1]) {
        modes.push(normalizeMode(match[1]));
      }
    }
    if (!modes.includes(FALLBACK_MODE)) modes.push(FALLBACK_MODE);
    return Array.from(new Set(modes)).filter(Boolean);
  }

  function getDefaultMode() {
    loadIfNeeded();
    const fromFile = readDefaultMode(cachedSections);
    const available = getAvailableModes();
    return available.includes(fromFile) ? fromFile : FALLBACK_MODE;
  }

  function getPromptPath() {
    return promptPath;
  }

  return {
    renderPrompt,
    getAvailableModes,
    getDefaultMode,
    getPromptPath
  };
}

module.exports = {
  createPromptManager,
  FALLBACK_MODE,
  FALLBACK_AUDIENCE,
  normalizeMode,
  normalizeAudience,
  normalizeName
};
