const PLUGIN_ID = 'clawpilot';

function loadBridgeConfig(api) {
  const cfg = api.runtime.config.loadConfig();
  const pluginCfg = cfg?.plugins?.entries?.[PLUGIN_ID]?.config || {};
  const bridgeBaseUrl = (pluginCfg.bridgeBaseUrl || process.env.COPILOT_BRIDGE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
  const bridgeToken = pluginCfg.bridgeToken || process.env.COPILOT_BRIDGE_TOKEN || '';
  return { bridgeBaseUrl, bridgeToken };
}

async function callBridge(api, path, method = 'GET') {
  const { bridgeBaseUrl, bridgeToken } = loadBridgeConfig(api);
  const headers = { 'Content-Type': 'application/json' };
  if (bridgeToken) headers.Authorization = `Bearer ${bridgeToken}`;

  const res = await fetch(`${bridgeBaseUrl}${path}`, { method, headers });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    throw new Error(`Bridge call failed (${res.status}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

export default function register(api) {
  api.registerCommand({
    name: 'clawpilot',
    description: 'Control Recall copilot bridge: status | mute | unmute | verbose-on | verbose-off',
    acceptsArgs: true,
    handler: async (ctx) => {
      const action = (ctx.args || 'status').trim().toLowerCase();

      try {
        if (!action || action === 'status') {
          const status = await callBridge(api, '/copilot/status');
          return { text: `ClawPilot status:\n${JSON.stringify(status, null, 2)}` };
        }
        if (action === 'mute') {
          const result = await callBridge(api, '/mute', 'POST');
          return { text: `Muted.\n${JSON.stringify(result, null, 2)}` };
        }
        if (action === 'unmute') {
          const result = await callBridge(api, '/unmute', 'POST');
          return { text: `Unmuted.\n${JSON.stringify(result, null, 2)}` };
        }
        if (action === 'verbose-on') {
          const result = await callBridge(api, '/meetverbose/on', 'POST');
          return { text: `Verbose ON.\n${JSON.stringify(result, null, 2)}` };
        }
        if (action === 'verbose-off') {
          const result = await callBridge(api, '/meetverbose/off', 'POST');
          return { text: `Verbose OFF.\n${JSON.stringify(result, null, 2)}` };
        }

        return {
          text: [
            'Usage: /clawpilot <action>',
            '',
            'Actions:',
            '- status',
            '- mute',
            '- unmute',
            '- verbose-on',
            '- verbose-off',
          ].join('\n'),
        };
      } catch (err) {
        return { text: `ClawPilot command failed: ${err.message}` };
      }
    },
  });
}
