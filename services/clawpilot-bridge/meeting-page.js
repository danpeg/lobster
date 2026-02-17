// Meeting Canvas - Real-time meeting notes page
// Integrated into the recall webhook server

const crypto = require('crypto');

const DEFAULT_SESSION_ID = 'default';
const ALLOWED_SECTION_TYPES = new Set(['heading', 'bullet', 'action', 'decision', 'note']);
const MAX_SECTIONS = Number(process.env.MEETING_MAX_SECTIONS || 500);
const MAX_EVENT_BACKLOG = Number(process.env.MEETING_EVENT_BACKLOG || 250);
const HEARTBEAT_MS = Number(process.env.MEETING_HEARTBEAT_MS || 15000);

const sessions = new Map();
const sseClients = new Set();

function nowIso() {
  return new Date().toISOString();
}

function resolveSessionId(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return DEFAULT_SESSION_ID;
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120) || DEFAULT_SESSION_ID;
}

function createSessionState(sessionId) {
  return {
    sessionId,
    title: 'Meeting Notes',
    lastUpdated: nowIso(),
    sections: [],
    eventSeq: 0,
    eventLog: []
  };
}

function getSessionState(sessionId = DEFAULT_SESSION_ID) {
  const normalized = resolveSessionId(sessionId);
  if (!sessions.has(normalized)) {
    sessions.set(normalized, createSessionState(normalized));
  }
  return sessions.get(normalized);
}

function getPublicState(sessionId = DEFAULT_SESSION_ID) {
  return toPublicState(getSessionState(sessionId));
}

function toPublicState(state) {
  return {
    sessionId: state.sessionId,
    title: state.title,
    lastUpdated: state.lastUpdated,
    sections: state.sections
  };
}

function writeSse(client, eventId, data) {
  try {
    client.res.write(`id: ${eventId}\n`);
    client.res.write(`data: ${data}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function removeSseClient(client) {
  if (!client) return;
  if (client.heartbeat) {
    clearInterval(client.heartbeat);
  }
  sseClients.delete(client);
}

function snapshotEvent(state) {
  return {
    id: state.eventSeq,
    data: JSON.stringify(toPublicState(state))
  };
}

function appendEvent(state) {
  state.eventSeq += 1;
  const event = {
    id: state.eventSeq,
    data: JSON.stringify(toPublicState(state))
  };
  state.eventLog.push(event);
  if (state.eventLog.length > MAX_EVENT_BACKLOG) {
    state.eventLog.splice(0, state.eventLog.length - MAX_EVENT_BACKLOG);
  }
  return event;
}

function broadcastUpdate(sessionId) {
  const state = getSessionState(sessionId);
  state.lastUpdated = nowIso();
  const event = appendEvent(state);
  for (const client of sseClients) {
    if (client.sessionId !== state.sessionId) continue;
    const ok = writeSse(client, event.id, event.data);
    if (!ok) {
      removeSseClient(client);
    }
  }
}

function addSection(sessionId, type, content, meta = {}) {
  const state = getSessionState(sessionId);
  const section = {
    id: crypto.randomUUID(),
    type: ALLOWED_SECTION_TYPES.has(type) ? type : 'bullet',
    content,
    meta,
    timestamp: nowIso()
  };
  state.sections.push(section);
  if (state.sections.length > MAX_SECTIONS) {
    state.sections.splice(0, state.sections.length - MAX_SECTIONS);
  }
  broadcastUpdate(state.sessionId);
  return section;
}

function updateSection(sessionId, id, content) {
  const state = getSessionState(sessionId);
  const targetId = String(id);
  const section = state.sections.find((s) => String(s.id) === targetId);
  if (!section) {
    return false;
  }
  section.content = content;
  section.timestamp = nowIso();
  broadcastUpdate(state.sessionId);
  return true;
}

function deleteSection(sessionId, id) {
  const state = getSessionState(sessionId);
  const targetId = String(id);
  const next = state.sections.filter((s) => String(s.id) !== targetId);
  if (next.length === state.sections.length) {
    return false;
  }
  state.sections = next;
  broadcastUpdate(state.sessionId);
  return true;
}

function clearMeeting(sessionId) {
  const state = getSessionState(sessionId);
  state.sections = [];
  state.title = 'Meeting Notes';
  broadcastUpdate(state.sessionId);
}

function setTitle(sessionId, title) {
  const state = getSessionState(sessionId);
  state.title = title;
  broadcastUpdate(state.sessionId);
}

function addSseClient(res, sessionId, lastEventId = 0) {
  const state = getSessionState(sessionId);
  const client = {
    id: crypto.randomUUID(),
    sessionId: state.sessionId,
    res,
    heartbeat: null
  };
  sseClients.add(client);
  const replayFrom = Number(lastEventId);
  if (Number.isFinite(replayFrom) && replayFrom > 0) {
    const replayEvents = state.eventLog.filter((e) => e.id > replayFrom);
    if (replayEvents.length > 0) {
      for (const event of replayEvents) {
        if (!writeSse(client, event.id, event.data)) {
          removeSseClient(client);
          return client;
        }
      }
    } else {
      const snap = snapshotEvent(state);
      writeSse(client, snap.id, snap.data);
    }
  } else {
    const snap = snapshotEvent(state);
    writeSse(client, snap.id, snap.data);
  }

  client.heartbeat = setInterval(() => {
    try {
      if (client.res.writableEnded || client.res.destroyed) {
        removeSseClient(client);
        return;
      }
      client.res.write(': ping\n\n');
    } catch {
      removeSseClient(client);
    }
  }, HEARTBEAT_MS);

  return client;
}

const meetingHTML = `<!DOCTYPE html>
<html>
<head>
  <title>Meeting Canvas</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e; 
      color: #eee;
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 800px; margin: 0 auto; }
    header { 
      display: flex; 
      justify-content: space-between; 
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 1px solid #333;
    }
    h1 { font-size: 1.5rem; color: #FF5A36; }
    .status { font-size: 0.8rem; color: #666; }
    .status.live { color: #4CAF50; }
    .section {
      background: #252540;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 10px;
      border-left: 3px solid #444;
      animation: fadeIn 0.3s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    .section.heading { border-left-color: #FF5A36; font-size: 1.2rem; font-weight: 600; }
    .section.bullet { border-left-color: #666; }
    .section.action { border-left-color: #4CAF50; }
    .section.action::before { content: "✅ "; }
    .section.decision { border-left-color: #2196F3; }
    .section.decision::before { content: "📋 "; }
    .section.note { border-left-color: #FFC107; font-style: italic; }
    .section.note::before { content: "💡 "; }
    .time { font-size: 0.7rem; color: #555; margin-top: 4px; }
    .empty { text-align: center; color: #555; padding: 40px; }
    .pulse { animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1 id="title">Meeting Notes</h1>
      <div class="status" id="status">Connecting...</div>
    </header>
    <div id="sections">
      <div class="empty pulse">Waiting for meeting notes...</div>
    </div>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    const session = params.get('session') || 'default';
    const streamUrl = '/meeting/stream?session=' + encodeURIComponent(session);
    const evtSource = new EventSource(streamUrl);
    const sectionsEl = document.getElementById('sections');
    const titleEl = document.getElementById('title');
    const statusEl = document.getElementById('status');
    
    evtSource.onopen = () => {
      statusEl.textContent = '🟢 Live';
      statusEl.className = 'status live';
    };
    
    evtSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      titleEl.textContent = data.title;
      
      if (data.sections.length === 0) {
        sectionsEl.innerHTML = '<div class="empty pulse">Waiting for meeting notes...</div>';
        return;
      }

      sectionsEl.replaceChildren();
      for (const s of data.sections) {
        const section = document.createElement('div');
        section.className = 'section ' + (s.type || 'bullet');
        section.dataset.id = String(s.id);

        const text = document.createElement('div');
        text.textContent = String(s.content || '');
        section.appendChild(text);

        const time = document.createElement('div');
        time.className = 'time';
        time.textContent = new Date(s.timestamp).toLocaleTimeString();
        section.appendChild(time);

        sectionsEl.appendChild(section);
      }
    };
    
    evtSource.onerror = () => {
      statusEl.textContent = '🟡 Reconnecting...';
      statusEl.className = 'status';
    };
  </script>
</body>
</html>`;

module.exports = {
  DEFAULT_SESSION_ID,
  ALLOWED_SECTION_TYPES,
  resolveSessionId,
  getSessionState,
  getPublicState,
  sseClients,
  addSseClient,
  removeSseClient,
  broadcastUpdate,
  addSection,
  updateSection,
  deleteSection,
  clearMeeting,
  setTitle,
  meetingHTML
};
