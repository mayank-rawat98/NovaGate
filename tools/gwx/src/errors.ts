export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
  }
}
export function safeText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .slice(0, 2048);
}
export const tenantPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
export function apiUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value.length > 2048 ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new CliError(
      'Use an HTTPS API URL, or HTTP on localhost. Embedded credentials, query strings and fragments are refused.',
      2,
    );
  }
}
