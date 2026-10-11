# Verified dependency extraction — issue #101

Use `node tools/npm-verified.mjs ci --no-audit --no-fund` for the locked
workspace install. It requires only Node builtins, so it runs before installing
dependencies. Docker builds also pass `--ignore-scripts`; reusable CI keeps
the existing lifecycle scripts enabled. Production dependency pruning uses
the same guard with `prune --omit=dev --ignore-scripts --offline`.

The guard streams npm output with backpressure and bounded diagnostic overlap.
It forces warning visibility and disables ANSI color after caller options. Any
`npm warn tar TAR_*` or `npm error tar TAR_*` diagnostic rejects the install,
even if npm returns zero. Normal npm failures retain their exit code. Missing
npm returns 127. SIGINT/SIGTERM propagate to the owned npm and lifecycle-script
process group on POSIX; completion waits for npm and its output streams.

This is a rejection gate, not a repair or automatic retry. A failed host install
can contain damaged files and must be discarded before reuse. A failed Docker
RUN cannot publish its image tag or cache a successful install layer. Copying
the guard before every install invalidates the earlier unguarded layer; it does
not repair already built images. The npm download cache is separate from the
installed dependency tree. Existing runtime, login and asset checks still apply.
An install with no reported extraction diagnostics is not a byte-by-byte audit
of every dependency.

## What is established

Two previous production builds emitted `TAR_ENTRY_ERROR EFAULT`. The first
accepted install contained a zero-byte Next.js `base-http/node.js`, with no
`NodeNextRequest` constructor. The second warning was rejected manually before
its installed files were inspected. Clean builds succeeded, but success after
a clean retry does not establish why the original filesystem writes failed.

The pinned Node 26.11.1 Alpine image currently bundles npm 11.20.0, tar 7.5.22
and libuv 1.52.1. In the installed npm sources, pacote's tar extraction warning
callback logs recoverable warnings without requesting strict extraction.
node-tar resumes after a recoverable entry write error. The corresponding
upstream sources are [pacote's fetcher](https://github.com/npm/pacote/blob/main/lib/fetcher.js)
and [node-tar 7.5.22's unpacker](https://github.com/isaacs/node-tar/blob/v7.5.22/src/unpack.ts).
This explains how npm can accept a damaged install after receiving a write
error; it does not explain the original kernel error.

Host memory pressure was observed during earlier failures, without a proven
causal link. The [libuv sources pinned in Node 26.11.1](https://github.com/nodejs/node/blob/v26.11.1/deps/uv/src/unix/linux.c)
also require explicit loop opt-in to enable io_uring SQPOLL. We have not
established that opt-in or a failing io_uring operation in these builds.
Changing kernel/runtime I/O settings or restarting unrelated services would
not be supported by this evidence. Issue #101 remains open for an actual
spontaneous failure trace and Node/libuv/kernel attribution.

## Repeatable regression

```sh
npm exec -- nx run admin-api:dependency-install-smoke
```

Requires Docker and the pinned `node:26.11.1-alpine` image. The target packs a
local fixture tarball, generates its real npm lock, and injects one EFAULT
through the filesystem write callback used by real npm/tar. It does not replace
npm with a fake CLI or generate a fake extraction log. No production install
loads the fault hook. No registry credentials or backing services are needed.

The fixture verifies:

- Unguarded npm returns zero with the warning, a zero-byte module and a missing
  constructor; the guarded install rejects that same damage.
- Quiet logging options/environment cannot hide the extraction warning.
- A healthy install preserves all 52 fixture bytes and its constructor; healthy
  pruning succeeds, while pruning that re-extracts the failed package rejects it.
- A normal prepare script runs; SIGTERM drains a real waiting prepare script
  and npm with exit 143. Missing lockfile/npm failures remain nonzero.
- A real Docker build rejects the extraction RUN and never publishes its tag.

The injected write error proves rejection behavior; it is not a reproduction
of the original OrbStack/kernel cause. Temporary files, containers and the
negative-test image tag belong only to this invocation and are cleaned up.
