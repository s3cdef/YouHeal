// Shared CLI helpers (argument parsing, TTY prompts, standard bootstrap).

import readline from 'node:readline';
import { loadConfig, ConfigError } from '../lib/config.js';
import { createLogger } from '../lib/log.js';

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

export function cliContext() {
  process.umask(0o077);
  try {
    const cfg = loadConfig();
    const log = createLogger({ level: cfg.logLevel === 'debug' ? 'debug' : 'warn' });
    return { cfg, log };
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(2);
  }
}

export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

export function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => {
      if (!muted) process.stdout.write(s);
      else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n');
    };
    rl.question(question, (a) => { rl.close(); resolve(a); });
    muted = true;
  });
}

export function requireTty() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('This command must be run from an interactive terminal (TTY).');
    process.exit(2);
  }
}

export function die(msg, code = 1) { console.error(msg); process.exit(code); }
