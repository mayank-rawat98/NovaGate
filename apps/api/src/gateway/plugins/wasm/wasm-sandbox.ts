import { Worker } from 'node:worker_threads';
import {
  WASM_MEMORY_MAX_PAGES,
  type WasmHook,
  type WasmModuleInspection,
} from '@api-gateway/shared-types';
import { WASM_WORKER_SOURCE } from './wasm-worker.source';

export interface WasmSandboxSettings {
  timeoutMs: number;
  workers: number;
  maxQueue: number;
  /** Development only: permit http:// for allowlisted hosts. */
  allowHttp: boolean;
}

export interface WasmCallInput {
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    consumerId?: string;
  };
  config: Record<string, unknown>;
  status?: number;
}

export interface WasmCallResult {
  actions: {
    setRequestHeaders: Record<string, string>;
    removeRequestHeaders: string[];
    setResponseHeaders: Record<string, string>;
    respond: { status: number; body: string } | null;
  };
  logs: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
  elapsedUs: number;
}

export class WasmSandboxError extends Error {
  constructor(
    readonly code: 'TIMEOUT' | 'TRAP' | 'BUSY' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

const HTTP_BODY_BYTES = 65536;
/** Instantiation (including a start function) gets a fixed, longer budget. */
const INIT_TIMEOUT_MS = 2000;

interface Pending {
  hook: WasmHook;
  input: WasmCallInput;
  resolve: (result: WasmCallResult) => void;
  reject: (error: Error) => void;
}

class SandboxWorker {
  readonly worker: Worker;
  readonly shared = new SharedArrayBuffer(16 + HTTP_BODY_BYTES);
  readonly ready: Promise<void>;
  busy: Pending | null = null;
  private timer?: NodeJS.Timeout;
  dead = false;

  constructor(
    module: WebAssembly.Module,
    memory: { initial: number; maximum: number },
    private readonly onHttp: (worker: SandboxWorker, url: string) => void,
    private readonly onExit: (worker: SandboxWorker) => void,
    private readonly onIdle: () => void,
  ) {
    this.worker = new Worker(WASM_WORKER_SOURCE, {
      eval: true,
      workerData: { module, memory, shared: this.shared },
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 4,
      },
      // No environment or arguments reach the plugin thread.
      env: {},
      argv: [],
      stdout: true,
      stderr: true,
    });
    this.worker.unref();
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new WasmSandboxError('TIMEOUT', 'Plugin instantiation timed out'),
        );
        void this.kill();
      }, INIT_TIMEOUT_MS);
      this.worker.once('message', (message) => {
        clearTimeout(timer);
        if (message.type === 'ready') resolve();
        else {
          reject(
            new WasmSandboxError(
              'TRAP',
              `Plugin failed to start: ${message.error}`,
            ),
          );
          void this.kill();
        }
      });
    });
    this.ready.catch(() => undefined);
    this.worker.on('message', (message) => {
      if (message.type === 'http') this.onHttp(this, message.url);
      else if (message.type === 'result') this.finish(message);
    });
    this.worker.on('error', () => void this.kill());
    this.worker.on('exit', () => {
      this.dead = true;
      clearTimeout(this.timer);
      if (this.busy) {
        this.busy.reject(new WasmSandboxError('TRAP', 'Plugin worker exited'));
        this.busy = null;
      }
      this.onExit(this);
    });
  }

  start(pending: Pending, timeoutMs: number) {
    this.busy = pending;
    this.timer = setTimeout(() => {
      // Wasm cannot be interrupted in place: end the thread.
      const call = this.busy;
      this.busy = null;
      call?.reject(
        new WasmSandboxError('TIMEOUT', `Plugin exceeded ${timeoutMs} ms`),
      );
      void this.kill();
    }, timeoutMs);
    this.worker.postMessage({
      type: 'call',
      id: 1,
      hook: pending.hook,
      timeoutMs,
      ...pending.input,
    });
  }

  private finish(message: {
    error: string | null;
    actions: WasmCallResult['actions'];
    logs: WasmCallResult['logs'];
    elapsedUs: number;
  }) {
    clearTimeout(this.timer);
    const call = this.busy;
    this.busy = null;
    if (!call) return;
    queueMicrotask(this.onIdle);
    if (message.error)
      call.reject(
        new WasmSandboxError('TRAP', `Plugin trapped: ${message.error}`),
      );
    else
      call.resolve({
        actions: message.actions,
        logs: message.logs,
        elapsedUs: message.elapsedUs,
      });
  }

  answerHttp(status: number, body?: Uint8Array) {
    const header = new Int32Array(this.shared, 0, 4);
    if (body) {
      const length = Math.min(body.length, HTTP_BODY_BYTES);
      new Uint8Array(this.shared, 16).set(body.subarray(0, length));
      Atomics.store(header, 2, length);
    } else Atomics.store(header, 2, 0);
    Atomics.store(header, 1, status);
    Atomics.store(header, 0, 1);
    Atomics.notify(header, 0);
  }

  async kill() {
    if (this.dead) return;
    this.dead = true;
    await this.worker.terminate().catch(() => undefined);
  }
}

/**
 * Runs one compiled module in a small pool of worker threads. Calls queue
 * (bounded) for a free worker; each has the configured deadline, after which
 * the worker thread is terminated and replaced on demand.
 */
export class WasmSandbox {
  private readonly workers = new Set<SandboxWorker>();
  private readonly queue: Pending[] = [];
  private readonly memory: { initial: number; maximum: number };
  private closed = false;

  constructor(
    private readonly module: WebAssembly.Module,
    inspection: WasmModuleInspection,
    private readonly allowedHosts: string[],
    private readonly settings: WasmSandboxSettings,
  ) {
    this.memory = {
      initial: inspection.memory.initial,
      maximum: Math.min(
        inspection.memory.maximum ?? WASM_MEMORY_MAX_PAGES,
        WASM_MEMORY_MAX_PAGES,
      ),
    };
  }

  run(hook: WasmHook, input: WasmCallInput): Promise<WasmCallResult> {
    if (this.closed)
      return Promise.reject(
        new WasmSandboxError('UNAVAILABLE', 'Plugin unloaded'),
      );
    if (this.queue.length >= this.settings.maxQueue)
      return Promise.reject(
        new WasmSandboxError('BUSY', 'Plugin queue is full'),
      );
    return new Promise((resolve, reject) => {
      this.queue.push({ hook, input, resolve, reject });
      void this.pump();
    });
  }

  private async pump() {
    while (this.queue.length && !this.closed) {
      let worker = [...this.workers].find((w) => !w.busy && !w.dead);
      if (!worker) {
        if (this.workers.size >= this.settings.workers) return;
        worker = new SandboxWorker(
          this.module,
          this.memory,
          (w, url) => void this.http(w, url),
          (w) => {
            this.workers.delete(w);
            void this.pump();
          },
          () => void this.pump(),
        );
        this.workers.add(worker);
      }
      const pending = this.queue.shift() as Pending;
      // Reserve the worker before awaiting its start.
      worker.busy = pending;
      try {
        await worker.ready;
      } catch (error) {
        worker.busy = null;
        pending.reject(error as Error);
        continue;
      }
      if (worker.dead) {
        worker.busy = null;
        this.queue.unshift(pending);
        continue;
      }
      worker.start(pending, this.settings.timeoutMs);
    }
  }

  private async http(worker: SandboxWorker, raw: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return worker.answerHttp(-1);
    }
    const allowedScheme =
      url.protocol === 'https:' ||
      (this.settings.allowHttp && url.protocol === 'http:');
    if (
      !allowedScheme ||
      url.username ||
      url.password ||
      !this.allowedHosts.includes(url.host.toLowerCase())
    )
      return worker.answerHttp(-1);
    try {
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader && size < HTTP_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
      await reader?.cancel().catch(() => undefined);
      const body = new Uint8Array(Math.min(size, HTTP_BODY_BYTES));
      let offset = 0;
      for (const chunk of chunks) {
        const part = chunk.subarray(0, body.length - offset);
        body.set(part, offset);
        offset += part.length;
        if (offset >= body.length) break;
      }
      worker.answerHttp(response.status, body);
    } catch {
      worker.answerHttp(-2);
    }
  }

  async close() {
    this.closed = true;
    for (const pending of this.queue.splice(0))
      pending.reject(new WasmSandboxError('UNAVAILABLE', 'Plugin unloaded'));
    await Promise.all([...this.workers].map((worker) => worker.kill()));
  }
}
