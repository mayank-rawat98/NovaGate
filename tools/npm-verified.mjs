#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

// npm/pacote can report a recoverable tar extraction error and still exit zero.
// Do not let that result become a successful CI job or cached Docker RUN layer.
const [command, ...args] = process.argv.slice(2);
if (!['ci', 'prune'].includes(command) || args.includes('--')) {
  console.error('Usage: node tools/npm-verified.mjs <ci|prune> [npm options]');
  process.exitCode = 1;
} else {
  const child = spawn(
    'npm',
    [command, ...args, '--loglevel=warn', '--color=false'],
    {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
      // Own the npm/lifecycle-script group so cancellation cannot orphan scripts.
      detached: process.platform !== 'win32',
    },
  );
  let extractionWarning = false;
  let receivedSignal;
  let spawnFailure;
  const listeners = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const listener = () => {
      receivedSignal = signal;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else if (child.pid) process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }

  // Keep only a small overlap for tokens split across output chunks. pipe()
  // forwards all diagnostics and applies backpressure without retaining logs.
  for (const [source, destination] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    let tail = '';
    source.setEncoding('utf8');
    source.on('data', (chunk) => {
      const text = tail + chunk;
      if (/\bnpm\s+(?:warn|error)\s+tar\s+TAR_[A-Z_]+\b/.test(text)) {
        extractionWarning = true;
      }
      tail = text.slice(-256);
    });
    source.pipe(destination, { end: false });
  }

  child.on('error', (error) => {
    spawnFailure = error;
    console.error(`Verified npm could not start: ${error.code ?? error.name}`);
    process.exitCode = error.code === 'ENOENT' ? 127 : 1;
  });
  // close waits for npm AND its output streams. Never turn a warning into a
  // retry, or exit while npm still owns dependency files.
  child.on('close', (code, signal) => {
    for (const [name, listener] of listeners) process.off(name, listener);
    if (extractionWarning) {
      console.error(
        'Verified npm rejected an extraction diagnostic. Discard this dependency install; inspect the npm output before rebuilding.',
      );
    }
    if (spawnFailure) {
      process.exitCode = spawnFailure.code === 'ENOENT' ? 127 : 1;
    } else if (receivedSignal || signal) {
      process.exitCode = 128 + constants.signals[receivedSignal ?? signal];
    } else {
      process.exitCode = code ?? process.exitCode ?? 1;
      if (extractionWarning && process.exitCode === 0) process.exitCode = 1;
    }
  });
}
