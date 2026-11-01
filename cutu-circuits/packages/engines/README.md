# Cutu Circuits headless engineering adapters

The runtime calls `compileCircuit`, `compileCad`, `exportCircuit`, and `exportCad`.
Each request launches a disposable Node process, with a 30 second deadline and
forced termination on success, failure, or timeout. User model code is local
trusted code; process isolation bounds computation, not filesystem privileges.

The CAD adapter bridges the incorporated CAD editor's existing worker protocol
onto Node IPC. Its original OCCT/Sucrase evaluation, parameter definitions,
shape normalization, geometry measurements, diagnostics, and serializers remain
in use, including mixed shapes/descriptors. WASM and the default Roboto font load
from installed local dependencies. Printability notes use the existing analysis.

Electronics uses CircuitRunner with the source editor's offline configuration
(`partsEngineDisabled: true`, `disableCdnLoading: true`), and the incorporated
editor's Circuit JSON parsing, component queries, lint, image and BOM modules.
Native source is retained; compiling does not rewrite it. SVG export returns the
schematic; compilation returns both schematic and PCB SVGs. No remote modules
or supplier lookup are needed for explicitly authored footprints.

Upstream implementation and MIT/dependency notices are retained in the
`cad-editor` and `electronics-editor` packages; exact source provenance is in
`../../sources.lock.json`. Tests exercise the real kernels and worker recovery.

From the repository root, run `npx tsx --test packages/engines/tests/engines.test.ts`
for kernel regression tests and `npx tsx packages/engines/tests/examples-smoke.ts`
for both checked-in engineering examples and their exports.
