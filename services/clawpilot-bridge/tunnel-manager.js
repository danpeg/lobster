const { spawn } = require('child_process');

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ig;

class CloudflaredQuickTunnelManager {
  constructor(options = {}) {
    this.binary = String(options.binary || 'cloudflared').trim() || 'cloudflared';
    this.localUrl = String(options.localUrl || '').trim();
    this.logger = options.logger || console;
    this.minRestartDelayMs = Number(options.minRestartDelayMs || 1000);
    this.maxRestartDelayMs = Number(options.maxRestartDelayMs || 15000);
    this.startArgs = ['tunnel', '--no-autoupdate', '--url', this.localUrl];
    this.child = null;
    this.starting = false;
    this.stopped = false;
    this.restartTimer = null;
    this.consecutiveFailures = 0;
    this.waiters = [];
    this.state = {
      status: 'idle',
      up: false,
      publicUrl: '',
      pid: null,
      generation: 0,
      lastError: '',
      restarts: 0,
      startedAt: null,
    };
  }

  getState() {
    return {
      status: this.state.status,
      up: this.state.up,
      public_url: this.state.publicUrl,
      pid: this.state.pid,
      generation: this.state.generation,
      last_error: this.state.lastError,
      restarts: this.state.restarts,
      started_at: this.state.startedAt,
      binary: this.binary,
      local_url: this.localUrl,
    };
  }

  async ensureStarted(timeoutMs = 20_000) {
    if (!this.localUrl) {
      throw new Error('cloudflared local URL is not configured');
    }
    if (this.state.up && this.state.publicUrl) {
      return this.state.publicUrl;
    }
    if (!this.child && !this.starting) {
      this.startProcess();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timeout: null };
      const timeout = Math.max(1, Number(timeoutMs) || 20_000);
      waiter.timeout = setTimeout(() => {
        this.removeWaiter(waiter);
        reject(new Error(`Timed out waiting for cloudflared quick tunnel (${timeout}ms)`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      this.child.kill('SIGTERM');
    }
    this.rejectWaiters(new Error('cloudflared manager stopped'));
    this.state.status = 'stopped';
    this.state.up = false;
    this.state.publicUrl = '';
  }

  startProcess() {
    if (this.stopped || this.child || this.starting) {
      return;
    }
    this.starting = true;
    this.state.status = 'starting';
    this.state.generation += 1;
    this.state.lastError = '';

    let child;
    try {
      child = spawn(this.binary, this.startArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.starting = false;
      this.handleStartFailure(err);
      return;
    }

    this.child = child;
    this.state.pid = child.pid || null;

    const handleOutput = (chunk, streamName) => {
      const text = String(chunk || '');
      if (!text) return;
      this.parseTunnelUrl(text);
      if (this.state.status !== 'up') {
        const lower = text.toLowerCase();
        if (
          lower.includes('error') ||
          lower.includes('failed') ||
          lower.includes('unable') ||
          lower.includes('not found')
        ) {
          this.state.lastError = text.trim().slice(0, 500);
        }
      }
      if (process.env.DEBUG_MODE === 'true') {
        this.logger.log(`[Tunnel:${streamName}] ${text.trimEnd()}`);
      }
    };

    child.stdout.on('data', (chunk) => handleOutput(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => handleOutput(chunk, 'stderr'));

    child.on('error', (err) => {
      this.handleStartFailure(err);
    });

    child.on('exit', (code, signal) => {
      const hadUrl = Boolean(this.state.publicUrl);
      const reason = `cloudflared exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      this.child = null;
      this.starting = false;
      this.state.pid = null;
      this.state.up = false;
      this.state.publicUrl = '';
      this.state.status = 'down';
      this.state.lastError = reason;
      if (this.stopped) {
        return;
      }
      this.consecutiveFailures += 1;
      this.scheduleRestart(hadUrl);
      this.rejectWaiters(new Error(reason));
    });
  }

  parseTunnelUrl(text) {
    QUICK_TUNNEL_URL_RE.lastIndex = 0;
    const match = QUICK_TUNNEL_URL_RE.exec(text);
    if (!match || !match[0]) {
      return;
    }
    const publicUrl = match[0].replace(/\/$/, '');
    if (!publicUrl) return;
    this.starting = false;
    this.consecutiveFailures = 0;
    this.state.status = 'up';
    this.state.up = true;
    this.state.publicUrl = publicUrl;
    this.state.startedAt = new Date().toISOString();
    this.state.lastError = '';
    this.resolveWaiters(publicUrl);
    this.logger.log(`[Tunnel] quick tunnel ready at ${publicUrl}`);
  }

  handleStartFailure(err) {
    const message = err?.message || String(err || 'unknown error');
    this.starting = false;
    this.child = null;
    this.state.status = 'down';
    this.state.up = false;
    this.state.publicUrl = '';
    this.state.pid = null;
    this.state.lastError = message;
    this.consecutiveFailures += 1;
    if (!this.stopped) {
      this.scheduleRestart(false);
    }
    this.rejectWaiters(new Error(message));
  }

  scheduleRestart(hadUrl) {
    if (this.stopped || this.restartTimer) return;
    const exponent = Math.max(0, Math.min(5, this.consecutiveFailures - 1));
    const delayMs = Math.min(this.maxRestartDelayMs, this.minRestartDelayMs * 2 ** exponent);
    this.state.restarts += 1;
    const warning = hadUrl
      ? 'Quick tunnel restarted; active bots may need relaunch for webhook continuity.'
      : 'Quick tunnel restart scheduled.';
    this.logger.warn(`[Tunnel] ${warning} retry_in_ms=${delayMs}`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startProcess();
    }, delayMs);
  }

  resolveWaiters(publicUrl) {
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(publicUrl);
    }
  }

  rejectWaiters(error) {
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  removeWaiter(target) {
    const idx = this.waiters.indexOf(target);
    if (idx >= 0) {
      this.waiters.splice(idx, 1);
      clearTimeout(target.timeout);
    }
  }
}

module.exports = {
  CloudflaredQuickTunnelManager,
};
