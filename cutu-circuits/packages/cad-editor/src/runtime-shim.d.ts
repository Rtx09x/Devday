// The emscripten glue ships without type declarations.
declare module 'replicad-opencascadejs/src/replicad_with_exceptions.js' {
  const init: (options?: { wasmBinary?: Uint8Array; locateFile?: (path: string) => string }) => Promise<unknown>;
  export default init;
}
declare module 'replicad-opencascadejs/src/replicad_single.js' {
  const init: (options?: { wasmBinary?: Uint8Array; locateFile?: (path: string) => string }) => Promise<unknown>;
  export default init;
}
