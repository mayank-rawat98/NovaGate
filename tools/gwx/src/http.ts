import { setTimeout as pause } from 'node:timers/promises';
import { CliError } from './errors';

export class Client {
  constructor(
    readonly api: string,
    readonly tenant: string,
    readonly token: string | undefined,
    readonly signal: AbortSignal,
  ) {}
  private async fetch(path: string, init: RequestInit, streaming = false) {
    let response: Response;
    const headersController = new AbortController();
    const headersDeadline = streaming
      ? setTimeout(() => headersController.abort(), 15000)
      : undefined;
    try {
      response = await fetch(`${this.api}${path}`, {
        ...init,
        redirect: 'error',
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...init.headers,
        },
        signal: streaming
          ? AbortSignal.any([this.signal, headersController.signal])
          : AbortSignal.any([this.signal, AbortSignal.timeout(15000)]),
      });
    } catch {
      if (this.signal.aborted) throw this.signal.reason;
      throw new CliError(
        'API connection failed or timed out. Check the API URL and connection. Submitted writes may already have committed.',
      );
    } finally {
      clearTimeout(headersDeadline);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const hint =
        (
          {
            401: 'Session or token is invalid, expired or revoked. Run gwx login again or replace GW_API_TOKEN.',
            403: 'Workspace access was refused, or the token lacks the scope for this command.',
            409: 'Configuration changed or the preview expired. Review a new preview before applying.',
            413: 'Configuration exceeds the server import limit.',
            400: 'Request or configuration is invalid. Check the documented schema.',
            503: 'API is busy or unavailable. Retry after checking current state.',
          } as Record<number, string>
        )[response.status] ?? 'Check the API URL and server availability.';
      throw new CliError(`API returned ${response.status}. ${hint}`);
    }
    return response;
  }
  path(suffix: string) {
    return `/tenants/${this.tenant}${suffix}`;
  }
  async text(
    path: string,
    init: RequestInit = {},
    limit = 1048576,
  ): Promise<string> {
    const response = await this.fetch(path, init);
    const reader = response.body?.getReader();
    if (!reader) throw new CliError('API returned an empty response.');
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > limit)
          throw new CliError('API response exceeds the CLI response limit.');
        chunks.push(chunk.value);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const source = await this.text(path, init);
    try {
      return JSON.parse(source);
    } catch {
      throw new CliError('API returned invalid JSON.');
    }
  }
  async stream(
    emit: (row: Record<string, unknown>) => Promise<void>,
    once: boolean,
  ) {
    let cursor: string | undefined;
    while (!this.signal.aborted) {
      const response = await this.fetch(
        this.path('/logs/stream'),
        {
          headers: {
            Accept: 'text/event-stream',
            ...(cursor ? { 'Last-Event-ID': cursor } : {}),
          },
        },
        true,
      );
      if (
        !response.headers.get('content-type')?.startsWith('text/event-stream')
      ) {
        await response.body?.cancel();
        throw new CliError('API did not return a log event stream.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new CliError('API returned an empty stream.');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '',
        data = '',
        event = '',
        id = '';
      try {
        while (!this.signal.aborted) {
          let idle = false;
          const idleDeadline = setTimeout(() => {
            idle = true;
            void reader.cancel().catch(() => undefined);
          }, 20000);
          let chunk;
          try {
            chunk = await reader.read();
          } finally {
            clearTimeout(idleDeadline);
          }
          if (idle)
            throw new CliError(
              'Log stream stopped sending heartbeats. Reconnect after checking server availability.',
            );
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (Buffer.byteLength(buffer) > 131072)
            throw new CliError('Log stream frame exceeds the CLI limit.');
          let newline: number;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            if (!line) {
              if (event === 'logs' && data) {
                let rows: unknown;
                try {
                  rows = JSON.parse(data);
                } catch {
                  throw new CliError('API returned invalid log stream data.');
                }
                if (
                  !Array.isArray(rows) ||
                  rows.length > 50 ||
                  rows.some(
                    (row) =>
                      !row || typeof row !== 'object' || Array.isArray(row),
                  )
                )
                  throw new CliError('API returned invalid log stream data.');
                for (const row of rows) await emit(row);
                if (id && /^[\w.-]{1,1024}$/.test(id)) cursor = id;
                else
                  throw new CliError(
                    'API returned an invalid log stream cursor.',
                  );
                if (once && rows.length) return;
              } else if (event === 'error')
                throw new CliError(
                  'Log stream was interrupted. Check current retention/privacy policy and reconnect.',
                );
              else if (event === 'gap')
                process.stderr.write(
                  'Retention removed records since the last cursor; remaining retained records follow.\n',
                );
              data = '';
              event = '';
              id = '';
            } else if (line.startsWith('data:'))
              data += line.slice(5).trimStart() + '\n';
            else if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('id:')) id = line.slice(3).trim();
            if (Buffer.byteLength(data) > 131072)
              throw new CliError('Log stream frame exceeds the CLI limit.');
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      await pause(1000, undefined, { signal: this.signal });
    }
  }
}
