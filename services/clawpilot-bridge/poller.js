#!/usr/bin/env node
/**
 * Recall.ai Polling Client
 * Polls for transcript events and sends summary pings via OpenClaw
 */

const https = require('https');
const { execSync } = require('child_process');

const POLL_URL = process.env.RECALL_POLL_URL || '';
const POLL_TOKEN = process.env.RECALL_POLL_TOKEN || '';
const POLL_INTERVAL_MS = 3000; // Poll every 3 seconds

let iterator = null;
let transcriptBuffer = [];
let lastReactionTime = 0;
const REACTION_COOLDOWN_MS = 20000; // React at most every 20 seconds
const MIN_NEW_WORDS = 30;

async function poll() {
  if (!POLL_URL || !POLL_TOKEN) {
    throw new Error('Missing RECALL_POLL_URL or RECALL_POLL_TOKEN');
  }
  const url = iterator ? `${POLL_URL}?iterator=${encodeURIComponent(iterator)}` : POLL_URL;
  
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${POLL_TOKEN}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`Parse error: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
  });
}

function processEvent(event) {
  const eventType = event.eventType || event.event_type;
  const payload = event.payload || event;
  
  console.log(`[${new Date().toISOString()}] Event: ${eventType}`);
  
  // Handle bot status events
  if (eventType?.startsWith('bot.')) {
    const status = eventType.replace('bot.', '');
    if (status === 'in_call_recording') {
      sendToTelegram('🎙️ Bot is recording. I\'m listening...');
      transcriptBuffer = [];
    } else if (status === 'done' || status === 'call_ended') {
      sendToTelegram(`📴 Meeting ended. Got ${transcriptBuffer.length} transcript segments.`);
    }
    return;
  }
  
  // Handle transcript events
  if (eventType === 'transcript.data' || eventType === 'transcript.partial_data') {
    const data = payload.data?.data || payload.data || {};
    const participant = data.participant || {};
    const speaker = participant.name || 'Unknown';
    const words = data.words || [];
    const text = words.map(w => w.text).join(' ');
    
    if (text) {
      transcriptBuffer.push({ speaker, text, timestamp: Date.now() });
      console.log(`[Transcript] ${speaker}: ${text}`);
      maybeReact();
    }
    return;
  }
  
  // Log other events
  console.log('Other event:', JSON.stringify(event).substring(0, 300));
}

function maybeReact() {
  const now = Date.now();
  
  if (now - lastReactionTime < REACTION_COOLDOWN_MS) {
    return;
  }
  
  const recentItems = transcriptBuffer.slice(-10);
  const recentText = recentItems.map(i => i.text).join(' ');
  const wordCount = recentText.split(/\s+/).length;
  
  if (wordCount < MIN_NEW_WORDS) {
    return;
  }
  
  lastReactionTime = now;
  
  const context = recentItems
    .map(i => `${i.speaker}: ${i.text}`)
    .join('\n');
  
  sendToTelegram(`🎧 Meeting update:\n\n${context}\n\n---\nBrief feedback incoming...`);
}

function sendToTelegram(message) {
  try {
    const escapedMessage = message.replace(/'/g, "'\\''");
    execSync(`openclaw send '${escapedMessage}'`, {
      timeout: 10000,
      stdio: 'pipe'
    });
    console.log('Sent to Telegram:', message.substring(0, 80) + '...');
  } catch (error) {
    console.error('Failed to send:', error.message);
  }
}

async function main() {
  console.log('Starting Recall poller...');
  console.log(`Polling every ${POLL_INTERVAL_MS}ms`);
  
  while (true) {
    try {
      const result = await poll();
      
      if (result.iterator) {
        iterator = result.iterator;
      }
      
      if (result.data && result.data.length > 0) {
        console.log(`Got ${result.data.length} events`);
        for (const event of result.data) {
          processEvent(event);
        }
      }
      
    } catch (error) {
      console.error('Poll error:', error.message);
    }
    
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(console.error);
