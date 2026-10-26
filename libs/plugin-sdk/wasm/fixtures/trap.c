/* Test fixture: traps on every request. */
#include "../novagate.h"
NG_EXPORT(on_request) int on_request(void) {
  __builtin_trap();
  return 0;
}
