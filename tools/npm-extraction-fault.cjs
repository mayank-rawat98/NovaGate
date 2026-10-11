// Verification only: inject one filesystem write failure into real npm/tar.
// No production install loads this hook.
const fs = require('node:fs');
const originalWrite = fs.write;
let injected = false;
fs.write = function (fd, ...args) {
  let target = '';
  try {
    target = fs.readlinkSync('/proc/self/fd/' + fd);
  } catch {
    // Most writes do not belong to the fixture package.
  }
  if (
    !injected &&
    target.endsWith('/node_modules/novagate-extraction-fixture/index.js')
  ) {
    injected = true;
    const error = Object.assign(
      new Error('EFAULT: bad address in system call argument, write'),
      { code: 'EFAULT', errno: -14, syscall: 'write' },
    );
    process.stderr.write('FIXTURE_FILE_WRITE_FAULT EFAULT\n');
    return setImmediate(() => args.at(-1)(error));
  }
  return originalWrite.call(this, fd, ...args);
};
