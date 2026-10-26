/* Test fixture: defines its own memory (built without --import-memory);
 * must be refused because the sandbox could not cap it. */
#include "../novagate.h"
NG_EXPORT(on_request) int on_request(void) { return 0; }
