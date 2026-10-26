/**
 * Worker-thread program for one WebAssembly plugin instance (issue #123),
 * evaluated with `new Worker(source, { eval: true })` so it ships inside the
 * gateway bundle. The module sees only the host functions below and a
 * host-created memory; there is no WASI, require, filesystem or network.
 * `http_get` blocks on a SharedArrayBuffer while the parent thread performs
 * the allowlisted fetch. Plain JavaScript: this string is not compiled.
 */
export const WASM_WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const MAX_TEXT = 65536;
const MAX_OPS = 64;
const MAX_LOGS = 16;
const MAX_HTTP = 4;
const TOKEN = /^[!#$%&'*+.^_|~0-9a-z-]{1,128}$/;
const VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const RESTRICTED_REQUEST = new Set(['host', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authorization',
  'proxy-connection', 'forwarded', 'x-request-id']);
const RESTRICTED_RESPONSE = new Set(['content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'upgrade', 'trailer', 'content-encoding']);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const http = new Int32Array(workerData.shared, 0, 4);
const httpBytes = new Uint8Array(workerData.shared, 16);
const memory = new WebAssembly.Memory(workerData.memory);
let call = null;

function bytes() { return new Uint8Array(memory.buffer); }
function read(pointer, length) {
  if (!Number.isInteger(pointer) || !Number.isInteger(length) || pointer < 0 ||
      length < 0 || length > MAX_TEXT || pointer + length > memory.buffer.byteLength)
    throw new Error('Out-of-bounds host call');
  return decoder.decode(bytes().subarray(pointer, pointer + length));
}
function write(value, pointer, capacity) {
  if (value === undefined || value === null) return -1;
  const data = typeof value === 'string' ? encoder.encode(value) : value;
  const count = Math.min(data.length, Math.max(0, capacity));
  if (pointer < 0 || pointer + count > memory.buffer.byteLength)
    throw new Error('Out-of-bounds host call');
  bytes().set(data.subarray(0, count), pointer);
  return data.length;
}
function current() {
  if (!call) throw new Error('Host call outside a hook');
  return call;
}
function op() {
  if (++current().ops > MAX_OPS) return false;
  return true;
}
function header(name, restricted) {
  const lower = name.toLowerCase();
  return TOKEN.test(lower) && !restricted.has(lower) && !lower.startsWith('x-forwarded-') &&
    !lower.startsWith('proxy-') ? lower : null;
}

const host = {
  log(level, pointer, length) {
    const state = current();
    if (state.logs.length < MAX_LOGS)
      state.logs.push({ level: level === 2 ? 'error' : level === 1 ? 'warn' : 'info',
        message: read(pointer, Math.min(length, 512)) });
  },
  get_method(out, capacity) { return write(current().request.method, out, capacity); },
  get_path(out, capacity) { return write(current().request.path, out, capacity); },
  get_header(namePointer, nameLength, out, capacity) {
    const value = current().request.headers[read(namePointer, nameLength).toLowerCase()];
    return write(value, out, capacity);
  },
  get_config(keyPointer, keyLength, out, capacity) {
    const config = current().config;
    const key = read(keyPointer, keyLength);
    if (!Object.prototype.hasOwnProperty.call(config, key)) return -1;
    const value = config[key];
    if (value === null || value === undefined) return -1;
    return write(typeof value === 'string' ? value
      : typeof value === 'object' ? JSON.stringify(value) : String(value), out, capacity);
  },
  get_consumer(out, capacity) { return write(current().request.consumerId, out, capacity); },
  get_response_status() { return current().status || 0; },
  set_request_header(namePointer, nameLength, valuePointer, valueLength) {
    const state = current();
    const name = header(read(namePointer, nameLength), RESTRICTED_REQUEST);
    const value = read(valuePointer, valueLength);
    if (state.hook !== 'on_request' || !name || valueLength > 8192 || !VALUE.test(value) || !op())
      return -1;
    state.actions.removeRequestHeaders = state.actions.removeRequestHeaders.filter((h) => h !== name);
    state.actions.setRequestHeaders[name] = value;
    return 0;
  },
  remove_request_header(namePointer, nameLength) {
    const state = current();
    const name = header(read(namePointer, nameLength), RESTRICTED_REQUEST);
    if (state.hook !== 'on_request' || !name || !op()) return -1;
    delete state.actions.setRequestHeaders[name];
    if (!state.actions.removeRequestHeaders.includes(name))
      state.actions.removeRequestHeaders.push(name);
    return 0;
  },
  set_response_header(namePointer, nameLength, valuePointer, valueLength) {
    const state = current();
    const name = header(read(namePointer, nameLength), RESTRICTED_RESPONSE);
    const value = read(valuePointer, valueLength);
    if (!name || valueLength > 8192 || !VALUE.test(value) || !op()) return -1;
    state.actions.setResponseHeaders[name] = value;
    return 0;
  },
  respond(status, bodyPointer, bodyLength) {
    const state = current();
    if (state.hook !== 'on_request' || state.actions.respond || !Number.isInteger(status) ||
        status < 200 || status > 599 || bodyLength > MAX_TEXT) return -1;
    state.actions.respond = { status, body: read(bodyPointer, bodyLength) };
    return 0;
  },
  http_get(urlPointer, urlLength, out, capacity) {
    const state = current();
    if (++state.httpCalls > MAX_HTTP) return -1;
    const url = read(urlPointer, urlLength);
    const remaining = state.deadline - Date.now();
    if (remaining <= 0) return -2;
    Atomics.store(http, 0, 0);
    parentPort.postMessage({ type: 'http', id: state.id, url });
    if (Atomics.wait(http, 0, 0, remaining) === 'timed-out') return -2;
    const status = Atomics.load(http, 1);
    if (status < 0) return status;
    const length = Atomics.load(http, 2);
    write(httpBytes.slice(0, length), out, capacity);
    return status;
  },
};

let instance;
try {
  instance = new WebAssembly.Instance(workerData.module, { env: { memory }, novagate: host });
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  parentPort.postMessage({ type: 'init-error', error: String(error && error.message || error).slice(0, 200) });
}

parentPort.on('message', (message) => {
  if (!instance || message.type !== 'call') return;
  call = {
    id: message.id, hook: message.hook, request: message.request,
    config: message.config || {}, status: message.status, ops: 0, logs: [],
    httpCalls: 0, deadline: Date.now() + message.timeoutMs,
    actions: { setRequestHeaders: {}, removeRequestHeaders: [], setResponseHeaders: {}, respond: null },
  };
  let error = null;
  const started = process.hrtime.bigint();
  try {
    const hook = instance.exports[message.hook];
    if (typeof hook === 'function') hook();
  } catch (failure) {
    error = String(failure && failure.message || failure).slice(0, 200);
  }
  const elapsedUs = Number((process.hrtime.bigint() - started) / 1000n);
  parentPort.postMessage({ type: 'result', id: call.id, error, actions: call.actions,
    logs: call.logs, elapsedUs });
  call = null;
});
`;
