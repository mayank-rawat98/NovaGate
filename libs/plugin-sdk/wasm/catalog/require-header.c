/* Refuses requests without a header.
 * Config: header (default x-api-key), status (default 401). */
#include "../novagate.h"

NG_EXPORT(on_request) int on_request(void) {
  char header[128], value[8];
  int length = ng_get_config(NG_STR("header"), header, sizeof header);
  if (length <= 0 || length > (int)sizeof header) {
    length = ng_strlen("x-api-key");
    memcpy(header, "x-api-key", length);
  }
  if (ng_get_header(header, length, value, sizeof value) >= 0) return 0;
  char status_text[8];
  int status = 401;
  int status_length = ng_get_config(NG_STR("status"), status_text, sizeof status_text);
  if (status_length > 0 && status_length <= 3) {
    status = 0;
    for (int i = 0; i < status_length; i++) status = status * 10 + (status_text[i] - '0');
    if (status < 400 || status > 499) status = 401;
  }
  static const char body[] =
      "{\"error\":\"MISSING_HEADER\",\"message\":\"A required header is missing\"}";
  ng_respond(status, body, sizeof body - 1);
  return 0;
}
