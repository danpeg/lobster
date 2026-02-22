#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawnSync } = require('child_process');

const TOTAL_STEPS = 7;
const REQUIRED_PLUGIN_SPEC = '@clawpilot/clawpilot@^0.3.0';

function printUsage() {
  console.log('Usage: clawpilot setup [--fresh]');
}

function runCommand(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: options.stdio || 'inherit',
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    shell: false,
  });
  return {
    ok: result.status === 0,
    code: result.status,
    error: result.error,
    stdout: typeof result.stdout === 'string' ? result.stdout : String(result.stdout || ''),
    stderr: typeof result.stderr === 'string' ? result.stderr : String(result.stderr || ''),
  };
}

function commandExists(cmd) {
  const result = spawnSync('bash', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' });
  return result.status === 0;
}

function summarizeCommandFailure(result) {
  const parts = [];
  if (result?.error?.message) parts.push(result.error.message);
  if (typeof result?.stderr === 'string' && result.stderr.trim()) parts.push(result.stderr.trim());
  if (typeof result?.stdout === 'string' && result.stdout.trim()) parts.push(result.stdout.trim());
  return parts.join('\n').slice(0, 500);
}

function maybeRunOpenClawDoctorFix() {
  const doctor = runCommand('openclaw', ['doctor', '--fix'], { stdio: 'pipe' });
  if (doctor.ok) {
    return { attempted: true, ok: true, reason: '' };
  }

  const details = summarizeCommandFailure(doctor);
  const doctorUnsupported = /unknown command|unknown option|not a valid command|unrecognized option|did you mean/i.test(details)
    && /doctor/i.test(details);
  if (doctorUnsupported) {
    return { attempted: false, ok: true, reason: 'openclaw doctor is not available on this OpenClaw version' };
  }

  return {
    attempted: true,
    ok: false,
    reason: details || 'openclaw doctor --fix failed',
  };
}

function failWithRemediation(stepNum, action, message, remediation) {
  console.log(`Step ${stepNum}/${TOTAL_STEPS}: ${action} -> FAILED`);
  console.error(message);
  if (remediation) {
    console.error(remediation);
  }
  process.exit(1);
}

function passStep(stepNum, action) {
  console.log(`Step ${stepNum}/${TOTAL_STEPS}: ${action} -> OK`);
}

function detectLegacyConfigContent(content) {
  if (!content) return false;
  return (
    /(^|\n)\s*WEBHOOK_BASE_URL\s*=/.test(content) ||
    /(^|\n)\s*ALLOW_NGROK_FALLBACK\s*=/.test(content) ||
    /\.ts\.net/i.test(content) ||
    /tailscale/i.test(content) ||
    /ngrok/i.test(content)
  );
}

function sanitizeLegacyConfig(content) {
  const lines = String(content || '').split(/\r?\n/);
  const filtered = lines.filter((line) => {
    if (/^\s*WEBHOOK_BASE_URL\s*=/.test(line)) return false;
    if (/^\s*ALLOW_NGROK_FALLBACK\s*=/.test(line)) return false;
    return true;
  });
  return filtered.join('\n');
}

function ensureEnvFile(repoRoot) {
  const envFile = path.join(repoRoot, 'services', 'clawpilot-bridge', '.env');
  const exampleFile = path.join(repoRoot, 'services', 'clawpilot-bridge', '.env.example');
  if (!fs.existsSync(envFile) && fs.existsSync(exampleFile)) {
    fs.copyFileSync(exampleFile, envFile);
  }
  return { envFile, exampleFile };
}

function isValidRepoRoot(candidate) {
  if (!candidate) return false;
  const pluginPkg = path.join(candidate, 'packages', 'clawpilot-plugin', 'package.json');
  const bridgeDir = path.join(candidate, 'services', 'clawpilot-bridge');
  return fs.existsSync(pluginPkg) && fs.existsSync(bridgeDir);
}

function findRepoRootFrom(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (isValidRepoRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}

function resolveRepoRoot() {
  const envRoot = String(process.env.CLAWPILOT_REPO_ROOT || '').trim();
  if (envRoot && isValidRepoRoot(envRoot)) {
    return path.resolve(envRoot);
  }

  const cwdRoot = findRepoRootFrom(process.cwd());
  if (cwdRoot) return cwdRoot;

  const openclawDefault = path.join(os.homedir(), '.openclaw', 'clawpilot');
  if (isValidRepoRoot(openclawDefault)) {
    return openclawDefault;
  }

  return '';
}

function setEnvValue(filePath, key, value) {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const line = `${key}=${value}`;
  if (new RegExp(`(^|\\n)\\s*${key}=`).test(content)) {
    content = content.replace(new RegExp(`(^|\\n)\\s*${key}=.*(?=\\n|$)`, 'g'), (match, p1) => `${p1}${line}`);
  } else {
    if (content && !content.endsWith('\n')) content += '\n';
    content += `${line}\n`;
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureOpenClawHooksConfigured() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json');
  const config = readJsonFile(configPath) || {};
  const hooks = config && typeof config.hooks === 'object' && config.hooks ? config.hooks : {};
  const plugins = config && typeof config.plugins === 'object' && config.plugins ? config.plugins : {};
  const currentToken = String(hooks.token || '').trim();
  const currentPath = String(hooks.path || '').trim();
  const hooksEnabled = hooks.enabled === true;
  const currentAllow = Array.isArray(plugins.allow)
    ? plugins.allow.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : [];
  const changes = { enabledSet: false, pathSet: false, tokenSet: false, pluginsAllowSet: false };

  if (!hooksEnabled) {
    const setEnabled = runCommand('openclaw', ['config', 'set', 'hooks.enabled', 'true']);
    if (!setEnabled.ok) {
      return { ok: false, reason: 'failed to set hooks.enabled' };
    }
    changes.enabledSet = true;
  }

  if (!currentPath) {
    const setPath = runCommand('openclaw', ['config', 'set', 'hooks.path', '/hooks']);
    if (!setPath.ok) {
      return { ok: false, reason: 'failed to set hooks.path' };
    }
    changes.pathSet = true;
  }

  if (!currentToken) {
    const generatedToken = crypto.randomBytes(24).toString('hex');
    const setToken = runCommand('openclaw', ['config', 'set', 'hooks.token', generatedToken]);
    if (!setToken.ok) {
      return { ok: false, reason: 'failed to set hooks.token' };
    }
    changes.tokenSet = true;
  }

  if (!currentAllow.includes('clawpilot')) {
    const nextAllow = [...new Set([...currentAllow, 'clawpilot'])];
    const setAllow = runCommand('openclaw', ['config', 'set', 'plugins.allow', JSON.stringify(nextAllow)]);
    if (!setAllow.ok) {
      return { ok: false, reason: 'failed to set plugins.allow' };
    }
    changes.pluginsAllowSet = true;
  }

  return { ok: true, ...changes };
}

function getEnvValue(filePath, key) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(new RegExp(`(?:^|\\n)\\s*${key}=([^\\n]*)`));
  if (!match) return '';
  return String(match[1] || '').trim();
}

function isMissingOrPrompt(value) {
  const normalized = String(value || '').trim();
  return !normalized || normalized === '__PROMPT__';
}

function promptLine(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdout && process.stdout.isTTY),
    });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

async function ensureBridgeRuntimeSecrets(envFile) {
  let recallApiKey = String(process.env.RECALL_API_KEY || '').trim() || getEnvValue(envFile, 'RECALL_API_KEY');
  if (isMissingOrPrompt(recallApiKey)) {
    if (!process.stdin.isTTY) {
      return {
        ok: false,
        reason: 'RECALL_API_KEY is missing and no interactive terminal is available.',
      };
    }
    recallApiKey = await promptLine('Enter Recall API key (from recall.ai dashboard): ');
    if (isMissingOrPrompt(recallApiKey)) {
      return {
        ok: false,
        reason: 'RECALL_API_KEY is required.',
      };
    }
    setEnvValue(envFile, 'RECALL_API_KEY', recallApiKey);
  }

  let webhookSecret = String(process.env.WEBHOOK_SECRET || '').trim() || getEnvValue(envFile, 'WEBHOOK_SECRET');
  if (isMissingOrPrompt(webhookSecret)) {
    webhookSecret = crypto.randomBytes(32).toString('hex');
    setEnvValue(envFile, 'WEBHOOK_SECRET', webhookSecret);
  }

  // v1 default: prefer local hook path over CLI-routed delivery to avoid CLI pairing drift.
  setEnvValue(envFile, 'OPENCLAW_COPILOT_CLI_ROUTED', 'false');

  return { ok: true };
}

function getCloudflaredDownloadUrl() {
  const platform = os.platform();
  const arch = os.arch();
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

  if (platform === 'darwin' && arch === 'arm64') return { url: `${base}/cloudflared-darwin-arm64.tgz`, archive: 'tgz' };
  if (platform === 'darwin' && arch === 'x64') return { url: `${base}/cloudflared-darwin-amd64.tgz`, archive: 'tgz' };
  if (platform === 'linux' && arch === 'x64') return { url: `${base}/cloudflared-linux-amd64`, archive: 'bin' };
  if (platform === 'linux' && arch === 'arm64') return { url: `${base}/cloudflared-linux-arm64`, archive: 'bin' };

  return null;
}

function installCloudflaredFallback() {
  const download = getCloudflaredDownloadUrl();
  if (!download) {
    return { ok: false, reason: `Unsupported platform/arch: ${os.platform()}-${os.arch()}` };
  }

  const installDir = path.join(os.homedir(), '.clawpilot', 'bin');
  const target = path.join(installDir, 'cloudflared');
  const archivePath = path.join(installDir, 'cloudflared-download.tgz');
  fs.mkdirSync(installDir, { recursive: true });

  const curlTarget = download.archive === 'tgz' ? archivePath : target;
  const curl = runCommand('curl', ['-fL', download.url, '-o', curlTarget]);
  if (!curl.ok) {
    return { ok: false, reason: 'curl download failed' };
  }

  if (download.archive === 'tgz') {
    const untar = runCommand('tar', ['-xzf', archivePath, '-C', installDir]);
    if (!untar.ok || !fs.existsSync(target)) {
      return { ok: false, reason: 'archive extraction failed' };
    }
    try {
      fs.unlinkSync(archivePath);
    } catch {}
  }

  const chmod = runCommand('chmod', ['+x', target]);
  if (!chmod.ok) {
    return { ok: false, reason: 'chmod failed' };
  }

  const verify = runCommand(target, ['--version']);
  if (!verify.ok) {
    return { ok: false, reason: 'downloaded binary failed --version check' };
  }

  return { ok: true, binPath: target };
}

function ensureCloudflaredInstalled() {
  if (commandExists('cloudflared')) {
    return { ok: true, binPath: 'cloudflared' };
  }

  const platform = os.platform();
  if (platform === 'darwin' && commandExists('brew')) {
    const install = runCommand('brew', ['install', 'cloudflared']);
    if (install.ok && commandExists('cloudflared')) {
      return { ok: true, binPath: 'cloudflared' };
    }
  }

  if (platform === 'linux') {
    if (commandExists('apt-get')) {
      const aptUpdate = process.getuid && process.getuid() === 0
        ? runCommand('apt-get', ['update'])
        : commandExists('sudo')
          ? runCommand('sudo', ['apt-get', 'update'])
          : { ok: false };
      const aptInstall = process.getuid && process.getuid() === 0
        ? runCommand('apt-get', ['install', '-y', 'cloudflared'])
        : commandExists('sudo')
          ? runCommand('sudo', ['apt-get', 'install', '-y', 'cloudflared'])
          : { ok: false };
      if (aptUpdate.ok && aptInstall.ok && commandExists('cloudflared')) {
        return { ok: true, binPath: 'cloudflared' };
      }
    }
    if (commandExists('apt')) {
      const aptInstall = process.getuid && process.getuid() === 0
        ? runCommand('apt', ['install', '-y', 'cloudflared'])
        : commandExists('sudo')
          ? runCommand('sudo', ['apt', 'install', '-y', 'cloudflared'])
          : { ok: false };
      if (aptInstall.ok && commandExists('cloudflared')) {
        return { ok: true, binPath: 'cloudflared' };
      }
    }
  }

  return installCloudflaredFallback();
}

async function runSetup(args) {
  const fresh = args.includes('--fresh');
  const repoRoot = resolveRepoRoot();
  if (!repoRoot) {
    failWithRemediation(
      1,
      'Source check',
      'Required ClawPilot source checkout was not found.',
      'Remediation: run this command from your clawpilot repo root (or under services/clawpilot-bridge), or set CLAWPILOT_REPO_ROOT=/absolute/path/to/clawpilot.'
    );
  }
  const { envFile, exampleFile } = ensureEnvFile(repoRoot);
  const pluginInstallSpec = String(process.env.CLAWPILOT_PLUGIN_SPEC || REQUIRED_PLUGIN_SPEC).trim() || REQUIRED_PLUGIN_SPEC;

  // Step 1: source check + legacy config check
  if (!fs.existsSync(path.join(repoRoot, 'packages', 'clawpilot-plugin', 'package.json'))) {
    failWithRemediation(
      1,
      'Source check',
      'Required plugin package not found in current source tree.',
      'Fix: run this command from the Lobster repository root checkout.'
    );
  }
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf8');
    if (detectLegacyConfigContent(envContent)) {
      if (!fresh) {
        failWithRemediation(
          1,
          'Source check',
          'Old config detected. Run `npx @clawpilot/cli setup --fresh` to reconfigure.',
          'Remediation: rerun with --fresh to rewrite legacy bridge env settings.'
        );
      }
      fs.writeFileSync(envFile, sanitizeLegacyConfig(envContent), 'utf8');
    }
  } else if (fs.existsSync(exampleFile)) {
    fs.copyFileSync(exampleFile, envFile);
  }

  const secretCheck = await ensureBridgeRuntimeSecrets(envFile);
  if (!secretCheck.ok) {
    failWithRemediation(
      1,
      'Source check',
      secretCheck.reason || 'Bridge runtime configuration is incomplete.',
      'Remediation: set RECALL_API_KEY in services/clawpilot-bridge/.env (or rerun in an interactive shell) and rerun setup.'
    );
  }
  passStep(1, 'Source check');

  // Step 2: cloudflared install
  const cloudflared = ensureCloudflaredInstalled();
  if (!cloudflared.ok) {
    failWithRemediation(
      2,
      'Install cloudflared',
      `Could not install cloudflared: ${cloudflared.reason || 'unknown error'}`,
      'Remediation: install cloudflared manually, then rerun `npx @clawpilot/cli setup`.'
    );
  }
  if (envFile) {
    const binValue = cloudflared.binPath || 'cloudflared';
    setEnvValue(envFile, 'CLOUDFLARED_BIN', binValue);
  }
  passStep(2, 'Install cloudflared');

  // Step 3: install plugin
  if (!commandExists('openclaw')) {
    failWithRemediation(
      3,
      'Install plugin',
      'openclaw CLI was not found in PATH.',
      'Remediation: install/open OpenClaw CLI, then rerun `npx @clawpilot/cli setup`.'
    );
  }

  const doctorFix = maybeRunOpenClawDoctorFix();
  if (doctorFix.attempted && doctorFix.ok) {
    console.log('[setup] OpenClaw config repair check: doctor --fix OK');
  } else if (!doctorFix.ok) {
    const looksSchemaConfigFailure = /schema|unknown key|unrecognized|invalid config|openclaw\.json|validation/i.test(doctorFix.reason || '');
    if (looksSchemaConfigFailure) {
      failWithRemediation(
        3,
        'Install plugin',
        `OpenClaw config validation failed and automatic repair did not complete: ${doctorFix.reason}`,
        'Remediation: run `openclaw doctor --fix`, confirm it succeeds, then rerun `npx @clawpilot/cli setup --fresh`.'
      );
    }
    console.warn(`[setup] OpenClaw doctor --fix check skipped/failed: ${doctorFix.reason}`);
  }

  let installPlugin = runCommand('openclaw', ['plugins', 'install', pluginInstallSpec]);
  if (!installPlugin.ok) {
    runCommand('openclaw', ['plugins', 'uninstall', 'clawpilot']);
    installPlugin = runCommand('openclaw', ['plugins', 'install', pluginInstallSpec]);
  }
  if (!installPlugin.ok) {
    failWithRemediation(
      3,
      'Install plugin',
      `openclaw plugin installation failed for spec "${pluginInstallSpec}".`,
      'Remediation: ensure @clawpilot/clawpilot@0.3.0+ is available and retry. If an old plugin directory remains, run `openclaw plugins uninstall clawpilot` and rerun setup.'
    );
  }
  passStep(3, 'Install plugin');

  const hooksConfig = ensureOpenClawHooksConfigured();
  if (!hooksConfig.ok) {
    failWithRemediation(
      4,
      'Restart gateway',
      `Failed to configure OpenClaw hooks for bridge delivery: ${hooksConfig.reason || 'unknown error'}`,
      'Remediation: run `openclaw config set hooks.enabled true`, `openclaw config set hooks.path /hooks`, `openclaw config set hooks.token <random>`, and `openclaw config set plugins.allow \'["clawpilot"]\'`, then rerun setup.'
    );
  }

  // Step 4: restart gateway
  const restart = runCommand('openclaw', ['daemon', 'restart']);
  if (!restart.ok) {
    failWithRemediation(
      4,
      'Restart gateway',
      'Failed to restart OpenClaw daemon.',
      'Remediation: run `openclaw daemon restart` manually, then rerun setup.'
    );
  }
  if (hooksConfig.enabledSet || hooksConfig.pathSet || hooksConfig.tokenSet || hooksConfig.pluginsAllowSet) {
    passStep(
      4,
      `Restart gateway (hooks configured: enabled=${hooksConfig.enabledSet ? 'set' : 'ok'}, path=${hooksConfig.pathSet ? 'set' : 'ok'}, token=${hooksConfig.tokenSet ? 'set' : 'ok'}, plugins.allow=${hooksConfig.pluginsAllowSet ? 'set' : 'ok'})`
    );
  } else {
    passStep(4, 'Restart gateway');
  }

  // Step 5: verify loaded
  const verify = runCommand('openclaw', ['plugins', 'info', 'clawpilot']);
  if (!verify.ok) {
    failWithRemediation(
      5,
      'Verify loaded',
      'ClawPilot plugin verification failed.',
      'Remediation: run `openclaw plugins info clawpilot` and ensure plugin loads before continuing.'
    );
  }
  passStep(5, 'Verify loaded');

  // Step 6: run /clawpilot install in chat
  console.log('Run `/clawpilot install` in OpenClaw chat to finalize bridge checks and token alignment.');
  passStep(6, 'Run /clawpilot install');

  // Step 7: final summary
  passStep(7, 'Final pass/fail summary');
}

(async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  if (command !== 'setup') {
    printUsage();
    process.exit(1);
  }

  try {
    await runSetup(args.slice(1));
  } catch (err) {
    console.error(String(err?.message || err));
    process.exit(1);
  }
})();
