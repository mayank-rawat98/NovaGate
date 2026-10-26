/**
 * The gateway's TypeScript libraries (es2022 + node 20 types) omit the
 * WebAssembly global; these are the only members the sandbox uses. Modules
 * are instantiated inside the worker thread source, which is plain JS.
 */
declare namespace WebAssembly {
  type Module = object;
  function compile(bytes: BufferSource): Promise<Module>;
}
