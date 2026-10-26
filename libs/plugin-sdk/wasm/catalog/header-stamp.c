/* Adds a header to the request, the response or both.
 * Config: header (default x-novagate-wasm), value (default 1),
 * target: request | response | both (default both). */
#include "../novagate.h"

static char header[128], value[512], target[16];
static int header_length, value_length, target_length;

static void load(void) {
  header_length = ng_get_config(NG_STR("header"), header, sizeof header);
  if (header_length <= 0 || header_length > (int)sizeof header) {
    header_length = ng_strlen("x-novagate-wasm");
    memcpy(header, "x-novagate-wasm", header_length);
  }
  value_length = ng_get_config(NG_STR("value"), value, sizeof value);
  if (value_length < 0 || value_length > (int)sizeof value) {
    value_length = 1;
    value[0] = '1';
  }
  target_length = ng_get_config(NG_STR("target"), target, sizeof target);
  if (target_length < 0 || target_length > (int)sizeof target) target_length = 0;
}

static int wants(const char *side) {
  return target_length == 0 ||
         ng_equal_ci(target, target_length, NG_STR("both")) ||
         ng_equal_ci(target, target_length, side, ng_strlen(side));
}

NG_EXPORT(on_request) int on_request(void) {
  load();
  if (wants("request"))
    ng_set_request_header(header, header_length, value, value_length);
  return 0;
}

NG_EXPORT(on_response) int on_response(void) {
  load();
  if (wants("response"))
    ng_set_response_header(header, header_length, value, value_length);
  return 0;
}
