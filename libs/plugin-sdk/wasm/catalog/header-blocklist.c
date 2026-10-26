/* Blocks requests whose header matches a listed value (case-insensitive).
 * Config: header (default x-country), values (comma-separated). */
#include "../novagate.h"

NG_EXPORT(on_request) int on_request(void) {
  char header[128], value[256], values[2048];
  int header_length = ng_get_config(NG_STR("header"), header, sizeof header);
  if (header_length <= 0 || header_length > (int)sizeof header) {
    header_length = ng_strlen("x-country");
    memcpy(header, "x-country", header_length);
  }
  int value_length = ng_get_header(header, header_length, value, sizeof value);
  if (value_length < 0 || value_length > (int)sizeof value) return 0;
  int list_length = ng_get_config(NG_STR("values"), values, sizeof values);
  if (list_length <= 0 || list_length > (int)sizeof values) return 0;
  int start = 0;
  for (int i = 0; i <= list_length; i++) {
    if (i == list_length || values[i] == ',') {
      int a = start, b = i;
      while (a < b && values[a] == ' ') a++;
      while (b > a && values[b - 1] == ' ') b--;
      if (b > a && ng_equal_ci(values + a, b - a, value, value_length)) {
        static const char body[] =
            "{\"error\":\"BLOCKED\",\"message\":\"Requests like this are blocked\"}";
        ng_respond(403, body, sizeof body - 1);
        return 0;
      }
      start = i + 1;
    }
  }
  return 0;
}
