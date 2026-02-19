#!/usr/bin/env node
const axios = require('axios');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const RECALL_API_KEY = process.env.RECALL_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel default

async function speak(botId, text) {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set');
  if (!RECALL_API_KEY) throw new Error('RECALL_API_KEY not set');
  if (!botId) throw new Error('Bot ID required');
  if (!text) throw new Error('Text required');

  console.log(`Generating TTS for: "${text}"`);
  
  // 1. Generate TTS with ElevenLabs
  const ttsResponse = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      text: text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.5, similarity_boost: 0.5 }
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      responseType: 'arraybuffer'
    }
  );

  console.log(`TTS generated: ${ttsResponse.data.byteLength} bytes`);

  // 2. Convert to base64
  const b64Audio = Buffer.from(ttsResponse.data).toString('base64');

  // 3. Send to Recall
  const recallResponse = await axios.post(
    `https://eu-central-1.recall.ai/api/v1/bot/${botId}/output_audio/`,
    { kind: 'mp3', b64_data: b64Audio },
    { headers: { 'Authorization': `Token ${RECALL_API_KEY}` } }
  );

  console.log('Audio sent to Recall:', recallResponse.status);
  return { success: true, bytes: ttsResponse.data.byteLength };
}

// CLI
const botId = process.argv[2];
const text = process.argv.slice(3).join(' ');

if (!botId || !text) {
  console.log('Usage: node speak.js <bot_id> <text>');
  process.exit(1);
}

speak(botId, text)
  .then(r => console.log('Done:', r))
  .catch(e => console.error('Error:', e.message));
