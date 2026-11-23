import { spawn } from 'node:child_process';
import { assertHestiaUser } from './validate.js';

const ALLOWED_TOP_COMMANDS = new Set([
  'core',
  'plugin',
  'theme',
  'option',
  'cache',
  'db',
  'config',
  'maintenance-mode',
  'transient',
  'user',
  'search-replace',
]);

const FORBIDDEN_SUBCOMMANDS = new Set(['cli', 'eval', 'eval-file', 'shell']);
const FORBIDDEN_FLAGS = ['--exec', '--require'];

export function getConfig() {
  return {
    mode: process.env.FLEET_MODE || 'hestia',
    wpCliBin: process.env.WP_CLI_BIN || '/usr/local/bin/wp',
    helperBin: process.env.HELPER_BIN || '/usr/local/sbin/wp-fleet-helper',
  };
}

function assertSafeWpArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('Empty WP-CLI arguments');
  }
  if (!ALLOWED_TOP_COMMANDS.has(args[0])) {
    throw new Error(`Disallowed WP-CLI command: ${args[0]}`);
  }
  if (args[1] && FORBIDDEN_SUBCOMMANDS.has(args[1])) {
    throw new Error(`Disallowed WP-CLI subcommand: ${args[0]} ${args[1]}`);
  }
  for (const arg of args) {
    const lower = String(arg).toLowerCase();
    for (const flag of FORBIDDEN_FLAGS) {
      if (lower === flag || lower.startsWith(`${flag}=`)) {
        throw new Error(`Disallowed WP-CLI flag: ${arg}`);
      }
    }
  }
}

function buildWpSpawn(site, wpArgs) {
  assertSafeWpArgs(wpArgs);
  const { mode, wpCliBin } = getConfig();
  const fullWpArgs = [`--path=${site.path}`, '--no-color', ...wpArgs];

  if (mode === 'local') {
    if (wpCliBin.endsWith('.phar')) {
      return { cmd: 'php', args: [wpCliBin, ...fullWpArgs] };
    }
    return { cmd: wpCliBin, args: fullWpArgs };
  }

  assertHestiaUser(site.user);
  return {
    cmd: 'sudo',
    args: ['-n', '-u', site.user, wpCliBin, ...fullWpArgs],
  };
}

export function runWp(site, wpArgs, { onLine, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const { cmd, args } = buildWpSpawn(site, wpArgs);
    const child = spawn(cmd, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`WP-CLI timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const handleChunk = (stream, chunk) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (onLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onLine(line, stream);
        }
      }
    };

    child.stdout.on('data', (c) => handleChunk('stdout', c));
    child.stderr.on('data', (c) => handleChunk('stderr', c));

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        const msg = stderr.trim() || stdout.trim() || `WP-CLI exited with code ${code}`;
        const err = new Error(msg);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

export function spawnWpRaw(site, wpArgs, stdio = ['pipe', 'pipe', 'pipe']) {
  const { cmd, args } = buildWpSpawn(site, wpArgs);
  return spawn(cmd, args, { shell: false, stdio });
}

export function runHelper(helperArgs, { onLine, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const { mode, helperBin } = getConfig();
    if (mode !== 'hestia') {
      return reject(new Error('wp-fleet-helper is only used in hestia mode'));
    }

    const child = spawn('sudo', ['-n', helperBin, ...helperArgs], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`Helper timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on('data', (c) => {
      const text = c.toString('utf8');
      stdout += text;
      if (onLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onLine(line, 'stdout');
        }
      }
    });

    child.stderr.on('data', (c) => {
      const text = c.toString('utf8');
      stderr += text;
      if (onLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onLine(line, 'stderr');
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `Helper exited with code ${code}`));
      }
    });
  });
}
