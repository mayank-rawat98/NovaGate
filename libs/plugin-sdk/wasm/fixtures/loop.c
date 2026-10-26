/* Test fixture: never returns. The sandbox must stop it at its deadline. */
#include "../novagate.h"
NG_EXPORT(on_request) int on_request(void) {
  volatile int forever = 1;
  while (forever) {
  }
  return 0;
}
