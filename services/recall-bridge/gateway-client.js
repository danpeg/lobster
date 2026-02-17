// Persistent Gateway WebSocket Client
// Maintains a warm connection to inject messages instantly

const WebSocket = require('ws');
const crypto = require('crypto');

class GatewayClient {
  constructor(url = 'ws://127.0.0.1:18789') {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.nonce = null;
    this.reconnectTimer = null;
    this.pendingMessages = [];
    this.pending = new Map();
  }

  connect() {
    if (this.ws) return;
    
    console.log('[Gateway] Connecting to', this.url);
    this.ws = new WebSocket(this.url);
    
    this.ws.on('open', () => {
      console.log('[Gateway] WebSocket opened');
    });
    
    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (e) {
        console.error('[Gateway] Parse error:', e.message);
      }
    });
    
    this.ws.on('close', (code, reason) => {
      console.log('[Gateway] Closed:', code, reason.toString());
      this.connected = false;
      this.ws = null;
      // Reconnect after 5 seconds
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    });
    
    this.ws.on('error', (err) => {
      console.error('[Gateway] Error:', err.message);
    });
  }
  
  handleMessage(msg) {
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      this.nonce = msg.payload?.nonce;
      console.log('[Gateway] Got challenge, nonce:', this.nonce?.substring(0, 8) + '...');
      this.sendAuth();
    } else if (msg.type === 'response') {
      console.log('[Gateway] Response:', msg.id, msg.result ? 'ok' : (msg.error || 'unknown'));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || msg.error));
        else resolve(msg.result);
      }
      // Check if this is the connect response
      if (msg.result && msg.result.policy) {
        console.log('[Gateway] Connected and authenticated!');
        this.connected = true;
        // Flush pending messages
        while (this.pendingMessages.length > 0) {
          const pending = this.pendingMessages.shift();
          this.request(pending.method, pending.params);
        }
      }
    } else {
      console.log('[Gateway] Event:', msg.event || msg.type);
    }
  }
  
  sendAuth() {
    // Send connect request - NO 'type' field, just id, method, params
    const params = {
      role: 'operator',
      scopes: ['operator.admin'],
      nonce: this.nonce,
      signedAtMs: Date.now()
    };
    this.request('connect', params);
  }
  
  request(method, params) {
    const id = crypto.randomUUID();
    const frame = { id, method, params };
    
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        console.log('[Gateway] Sending:', method);
        this.ws.send(JSON.stringify(frame));
      } else {
        reject(new Error('WebSocket not open'));
      }
    });
  }
  
  // Inject a system event into the session
  async injectSystemEvent(sessionKey, text) {
    if (!this.connected) {
      console.log('[Gateway] Queuing message (not connected)');
      this.pendingMessages.push({ method: 'system.event', params: { sessionKey, text } });
      return false;
    }
    
    try {
      console.log('[Gateway] Injecting system event');
      await this.request('system.event', { sessionKey, text });
      return true;
    } catch (e) {
      console.error('[Gateway] Inject failed:', e.message);
      return false;
    }
  }
  
  close() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }
}

module.exports = { GatewayClient };
