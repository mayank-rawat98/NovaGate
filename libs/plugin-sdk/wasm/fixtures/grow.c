/* Test fixture: tries to grow memory past the 10 MiB cap and reports it. */
#include "../novagate.h"
NG_EXPORT(on_request) int on_request(void) {
  char text[12];
  int big = __builtin_wasm_memory_grow(0, 200);
  int small = __builtin_wasm_memory_grow(0, 1);
  ng_set_request_header(NG_STR("x-grow-200"), text,
                        big < 0 ? (text[0] = '-', text[1] = '1', 2) : ng_itoa(big, text));
  ng_set_request_header(NG_STR("x-grow-1"), text,
                        small < 0 ? (text[0] = '-', text[1] = '1', 2) : ng_itoa(small, text));
  return 0;
}
