#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const TEST_PORT = Number(process.env.TEST_PORT || 3301);
const HOOK_HOST = '127.0.0.1';
const WEBHOOK_SECRET = 'test-webhook-secret';
const HOOK_TOKEN = 'test-openclaw-hook-token';
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 12000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson({ method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function main() {
  const hookEvents = [];
  let hookReceivedAt = null;
  let usingMockHook = true;
  let mockHookPort = null;

  const hookServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hooks/wake') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${HOOK_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad token', auth }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      hookReceivedAt = Date.now();
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = { raw: body };
      }
      hookEvents.push({
        ts: hookReceivedAt,
        auth,
        body: parsed,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  try {
    await new Promise((resolve, reject) => {
      hookServer.once('error', reject);
      hookServer.listen(0, HOOK_HOST, () => {
        const address = hookServer.address();
        if (address && typeof address === 'object' && Number.isFinite(address.port)) {
          mockHookPort = address.port;
        }
        resolve();
      });
    });
  } catch (err) {
    usingMockHook = false;
  }

  const hookUrl = usingMockHook && mockHookPort
    ? `http://${HOOK_HOST}:${mockHookPort}/hooks/wake`
    : `http://${HOOK_HOST}:18789/hooks/wake`;

  const serverPath = path.join(__dirname, 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      HOST: '127.0.0.1',
      RECALL_API_KEY: 'test-recall-key',
      WEBHOOK_SECRET,
      TELEGRAM_BOT_TOKEN: 'test-telegram-token',
      DAN_CHAT_ID: '123456',
      OPENCLAW_HOOK_TOKEN: HOOK_TOKEN,
      OPENCLAW_HOOK_URL: hookUrl,
      DEBUG_MODE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let childOut = '';
  let childErr = '';
  child.stdout.on('data', (d) => {
    childOut += d.toString();
  });
  child.stderr.on('data', (d) => {
    childErr += d.toString();
  });

  try {
    const start = Date.now();
    let healthy = false;
    while (Date.now() - start < 8000) {
      try {
        const health = await requestJson({
          method: 'GET',
          url: `http://127.0.0.1:${TEST_PORT}/health`,
        });
        if (health.status === 200 && health.body && health.body.status === 'ok') {
          healthy = true;
          break;
        }
      } catch {}
      await sleep(150);
    }

    if (!healthy) {
      throw new Error('recall-webhook server did not become healthy');
    }

    const transcriptWords = [
      'hello', 'team', 'this', 'is', 'a', 'live', 'integration', 'test', 'for', 'meeting',
      'copilot', 'please', 'suggest', 'one', 'actionable', 'next', 'step', 'for', 'dan',
      'right', 'now', 'thanks',
    ];

    const webhookPayload = {
      event: 'transcript.data',
      data: {
        data: {
          participant: { name: 'Test Speaker' },
          words: transcriptWords.map((text, i) => ({
            text,
            start_timestamp: { relative: i * 0.2 + 1 },
          })),
        },
      },
    };

    const sendAt = Date.now();
    const webhookRes = await requestJson({
      method: 'POST',
      url: `http://127.0.0.1:${TEST_PORT}/webhook?token=${WEBHOOK_SECRET}`,
      body: webhookPayload,
    });

    if (webhookRes.status !== 200) {
      throw new Error(`webhook POST failed: ${webhookRes.status} ${webhookRes.raw}`);
    }

    let latencyMs = null;
    let hookBody = {};
    let hasTranscriptMarker = false;
    let hasSpeaker = false;

    if (usingMockHook) {
      const waitStart = Date.now();
      while (!hookReceivedAt && Date.now() - waitStart < TIMEOUT_MS) {
        await sleep(100);
      }

      if (!hookReceivedAt) {
        throw new Error(`OpenClaw hook was not called within ${TIMEOUT_MS}ms`);
      }

      latencyMs = hookReceivedAt - sendAt;
      hookBody = hookEvents[0]?.body || {};
      const text = hookBody.text || '';
      hasTranscriptMarker = text.includes('[MEETING TRANSCRIPT');
      hasSpeaker = text.includes('Test Speaker:');
    } else {
      const waitStart = Date.now();
      while (Date.now() - waitStart < TIMEOUT_MS) {
        if (childOut.includes('[FastInject]') && childOut.includes('success')) {
          hookReceivedAt = Date.now();
          latencyMs = hookReceivedAt - sendAt;
          hasTranscriptMarker = true;
          hasSpeaker = true;
          break;
        }
        await sleep(100);
      }

      if (!hookReceivedAt) {
        throw new Error(`Did not observe FastInject success log within ${TIMEOUT_MS}ms`);
      }
    }

    const result = {
      ok: true,
      mode: usingMockHook ? 'mock_hook' : 'real_gateway',
      webhookStatus: webhookRes.status,
      hookCalls: hookEvents.length,
      latencyMs,
      assertions: {
        transcriptMarker: hasTranscriptMarker,
        speakerIncluded: hasSpeaker,
      },
      sampleHookPayload: hookBody,
    };

    const assertionFailed = !hasTranscriptMarker || !hasSpeaker;
    if (assertionFailed) {
      result.ok = false;
      result.error = 'assertion failed';
    }

    console.log(JSON.stringify(result, null, 2));
    process.exitCode = assertionFailed ? 1 : 0;
  } finally {
    child.kill('SIGTERM');
    await sleep(150);
    if (usingMockHook) {
      hookServer.close();
    }
    if (childOut) {
      process.stderr.write(`\n[recall-webhook stdout]\n${childOut}\n`);
    }
    if (childErr) {
      process.stderr.write(`\n[recall-webhook stderr]\n${childErr}\n`);
    }
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: err.message,
      },
      null,
      2
    )
  );
  process.exit(1);
});
