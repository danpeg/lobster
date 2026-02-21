#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
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
  };
}

function commandExists(cmd) {
  const result = spawnSync('bash', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' });
  return result.status === 0;
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

function getCloudflaredDownloadUrl() {
  const platform = os.platform();
  const arch = os.arch();
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

  if (platform === 'darwin' && arch === 'arm64') return `${base}/cloudflared-darwin-arm64`;
  if (platform === 'darwin' && arch === 'x64') return `${base}/cloudflared-darwin-amd64`;
  if (platform === 'linux' && arch === 'x64') return `${base}/cloudflared-linux-amd64`;
  if (platform === 'linux' && arch === 'arm64') return `${base}/cloudflared-linux-arm64`;

  return '';
}

function installCloudflaredFallback() {
  const url = getCloudflaredDownloadUrl();
  if (!url) {
    return { ok: false, reason: `Unsupported platform/arch: ${os.platform()}-${os.arch()}` };
  }

  const installDir = path.join(os.homedir(), '.clawpilot', 'bin');
  const target = path.join(installDir, 'cloudflared');
  fs.mkdirSync(installDir, { recursive: true });

  const curl = runCommand('curl', ['-fL', url, '-o', target]);
  if (!curl.ok) {
    return { ok: false, reason: 'curl download failed' };
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

function runSetup(args) {
  const fresh = args.includes('--fresh');
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
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
          'Old config detected. Run `npx clawpilot setup --fresh` to reconfigure.',
          'Remediation: rerun with --fresh to rewrite legacy bridge env settings.'
        );
      }
      fs.writeFileSync(envFile, sanitizeLegacyConfig(envContent), 'utf8');
    }
  } else if (fs.existsSync(exampleFile)) {
    fs.copyFileSync(exampleFile, envFile);
  }
  passStep(1, 'Source check');

  // Step 2: cloudflared install
  const cloudflared = ensureCloudflaredInstalled();
  if (!cloudflared.ok) {
    failWithRemediation(
      2,
      'Install cloudflared',
      `Could not install cloudflared: ${cloudflared.reason || 'unknown error'}`,
      'Remediation: install cloudflared manually, then rerun `npx clawpilot setup`.'
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
      'Remediation: install/open OpenClaw CLI, then rerun `npx clawpilot setup`.'
    );
  }
  const installPlugin = runCommand('openclaw', ['plugins', 'install', pluginInstallSpec]);
  if (!installPlugin.ok) {
    failWithRemediation(
      3,
      'Install plugin',
      `openclaw plugin installation failed for spec "${pluginInstallSpec}".`,
      'Remediation: publish @clawpilot/clawpilot@0.3.0+ and rerun, or set CLAWPILOT_PLUGIN_SPEC to a tested tarball/spec.'
    );
  }
  passStep(3, 'Install plugin');

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
  passStep(4, 'Restart gateway');

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

(function main() {
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

  runSetup(args.slice(1));
})();
