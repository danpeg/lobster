const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:18789');

ws.on('open', () => {
  console.log('✅ WebSocket connected!');
  
  // Try sending a message - let's see what the protocol expects
  ws.send(JSON.stringify({ type: 'ping' }));
});

ws.on('message', (data) => {
  console.log('📥 Received:', data.toString().substring(0, 200));
});

ws.on('error', (err) => {
  console.log('❌ Error:', err.message);
});

ws.on('close', (code, reason) => {
  console.log('🔒 Closed:', code, reason.toString());
});

setTimeout(() => {
  console.log('Timeout - closing');
  ws.close();
  process.exit(0);
}, 3000);
