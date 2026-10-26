/* Test fixture: GETs config url and reports the status and body. */
#include "../novagate.h"
NG_EXPORT(on_request) int on_request(void) {
  char url[512], body[64], text[12];
  int url_length = ng_get_config(NG_STR("url"), url, sizeof url);
  if (url_length <= 0 || url_length > (int)sizeof url) return 0;
  int status = ng_http_get(url, url_length, body, sizeof body);
  int length = status < 0 ? (text[0] = '-', text[1] = (char)('0' - status), 2)
                          : ng_itoa(status, text);
  ng_set_request_header(NG_STR("x-http-status"), text, length);
  if (status >= 0) {
    int n = 0;
    while (n < (int)sizeof body && body[n] && body[n] != '\n') n++;
    ng_set_request_header(NG_STR("x-http-body"), body, n);
  }
  return 0;
}
