/* Test fixture: echoes request facts into headers and stamps the response
 * with the upstream status; refuses to set restricted headers. */
#include "../novagate.h"
NG_EXPORT(on_request) int on_request(void) {
  char buffer[256];
  int n = ng_get_method(buffer, sizeof buffer);
  ng_set_request_header(NG_STR("x-echo-method"), buffer, n);
  n = ng_get_path(buffer, sizeof buffer);
  ng_set_request_header(NG_STR("x-echo-path"), buffer, n);
  n = ng_get_header(NG_STR("x-input"), buffer, sizeof buffer);
  if (n >= 0) ng_set_request_header(NG_STR("x-echo-input"), buffer, n);
  n = ng_get_consumer(buffer, sizeof buffer);
  if (n >= 0) ng_set_request_header(NG_STR("x-echo-consumer"), buffer, n);
  ng_remove_request_header(NG_STR("x-remove-me"));
  char result[2] = {'0', 0};
  if (ng_set_request_header(NG_STR("host"), NG_STR("evil.example")) < 0) result[0] = 'r';
  ng_set_request_header(NG_STR("x-echo-restricted"), result, 1);
  ng_log(NG_LOG_INFO, NG_STR("echo ran"));
  return 0;
}
NG_EXPORT(on_response) int on_response(void) {
  char text[12];
  int n = ng_itoa(ng_get_response_status(), text);
  ng_set_response_header(NG_STR("x-echo-status"), text, n);
  return 0;
}
