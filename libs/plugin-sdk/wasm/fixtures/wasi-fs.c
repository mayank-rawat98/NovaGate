/* Test fixture: imports a WASI filesystem call; must be refused. */
#include "../novagate.h"
__attribute__((import_module("wasi_snapshot_preview1"), import_name("path_open")))
int path_open(int, int, const char *, int, int, long long, long long, int, int *);
NG_EXPORT(on_request) int on_request(void) {
  int fd;
  return path_open(3, 0, "/etc/passwd", 11, 0, 0, 0, 0, &fd);
}
