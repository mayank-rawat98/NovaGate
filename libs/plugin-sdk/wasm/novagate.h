/*
 * NovaGate WebAssembly plugin SDK (C). Plugins import their memory from the
 * host and may call only these functions; there is no WASI, filesystem or
 * network access except ng_http_get to the plugin's allowlisted hosts.
 *
 * Build: clang --target=wasm32 -O2 -nostdlib -Wl,--no-entry
 *   -Wl,--import-memory -Wl,--initial-memory=131072 -Wl,--strip-all
 *
 * Getters return the full length (writing at most cap bytes) or -1 when
 * absent. Setters return 0, or -1 when refused (invalid or restricted name,
 * value or limits). Hooks return 0.
 */
#ifndef NOVAGATE_H
#define NOVAGATE_H

#define NG_IMPORT(name) \
  __attribute__((import_module("novagate"), import_name(#name)))
#define NG_EXPORT(name) __attribute__((export_name(#name)))

enum { NG_LOG_INFO = 0, NG_LOG_WARN = 1, NG_LOG_ERROR = 2 };

NG_IMPORT(log) void ng_log(int level, const char *message, int length);
NG_IMPORT(get_method) int ng_get_method(char *out, int cap);
NG_IMPORT(get_path) int ng_get_path(char *out, int cap);
NG_IMPORT(get_header)
int ng_get_header(const char *name, int name_length, char *out, int cap);
/* Top-level key of the route's plugin config, as text. */
NG_IMPORT(get_config)
int ng_get_config(const char *key, int key_length, char *out, int cap);
/* Gateway consumer ID of an authenticated consumer key. */
NG_IMPORT(get_consumer) int ng_get_consumer(char *out, int cap);
/* In on_response: the upstream status. */
NG_IMPORT(get_response_status) int ng_get_response_status(void);
NG_IMPORT(set_request_header)
int ng_set_request_header(const char *name, int name_length,
                          const char *value, int value_length);
NG_IMPORT(remove_request_header)
int ng_remove_request_header(const char *name, int name_length);
NG_IMPORT(set_response_header)
int ng_set_response_header(const char *name, int name_length,
                           const char *value, int value_length);
/* In on_request: answer the client instead of proxying. */
NG_IMPORT(respond) int ng_respond(int status, const char *body, int length);
/* HTTPS GET to an allowlisted host; returns the status or -1 when refused,
 * -2 on failure or timeout. Writes at most cap body bytes. */
NG_IMPORT(http_get)
int ng_http_get(const char *url, int url_length, char *out, int cap);

static inline int ng_strlen(const char *s) {
  int n = 0;
  while (s[n]) n++;
  return n;
}
#define NG_STR(s) s, ng_strlen(s)

static inline int ng_equal_ci(const char *a, int a_length, const char *b,
                              int b_length) {
  if (a_length != b_length) return 0;
  for (int i = 0; i < a_length; i++) {
    char x = a[i], y = b[i];
    if (x >= 'A' && x <= 'Z') x += 32;
    if (y >= 'A' && y <= 'Z') y += 32;
    if (x != y) return 0;
  }
  return 1;
}

/* Writes a non-negative integer; returns its length. */
static inline int ng_itoa(int value, char *out) {
  char digits[12];
  int n = 0;
  if (value < 0) value = 0;
  do {
    digits[n++] = (char)('0' + value % 10);
    value /= 10;
  } while (value);
  for (int i = 0; i < n; i++) out[i] = digits[n - 1 - i];
  return n;
}

/* Freestanding builds: the compiler may emit these. */
void *memset(void *dest, int c, unsigned long n) {
  unsigned char *d = dest;
  while (n--) *d++ = (unsigned char)c;
  return dest;
}
void *memcpy(void *dest, const void *src, unsigned long n) {
  unsigned char *d = dest;
  const unsigned char *s = src;
  while (n--) *d++ = *s++;
  return dest;
}

#endif
