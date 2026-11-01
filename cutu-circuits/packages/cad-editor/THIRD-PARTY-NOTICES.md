# Third-Party Notices

This extension is distributed under the MIT License (see [`LICENSE`](./LICENSE)).
It builds on, and at runtime ships compiled output derived from, the following
third-party software. All bundled dependencies are MIT-licensed.

## Runtime dependencies

| Package | Version | License | Project |
| --- | --- | --- | --- |
| [replicad](https://replicad.xyz) | 0.23.x | MIT | TypeScript modeling API over OpenCascade |
| [replicad-opencascadejs](https://www.npmjs.com/package/replicad-opencascadejs) | 0.23.x | MIT | OpenCascade.js build packaged for Replicad |
| [three](https://threejs.org/) | 0.181.x | MIT | WebGL 3D rendering (live preview) |
| [sucrase](https://github.com/alangpierce/sucrase) | 3.35.x | MIT | TypeScript/JSX transpile-on-compile |
| [js-yaml](https://github.com/nodeca/js-yaml) | 4.x | MIT | Parses `.nimbalyst/replicad.yml` conventions |

## OpenCascade Technology (OCCT)

The bundled WebAssembly CAD kernel (`dist/replicad.wasm.b64`, decoded at runtime)
originates from [OpenCascade Technology](https://dev.opencascade.org/), compiled
to WebAssembly via [OpenCascade.js](https://ocjs.org/) and redistributed through
the MIT-licensed `replicad-opencascadejs` package. We ship the
`with_exceptions` build so kernel failures surface as catchable JavaScript errors
rather than aborting the wasm instance.

OpenCascade Technology is the work of Open Cascade SAS and contributors. See the
[OpenCascade.js](https://github.com/donalffons/opencascade.js) and
[OCCT](https://github.com/Open-Cascade-SAS/OCCT) projects for upstream source and
licensing details.

## Generating an up-to-date license report

To regenerate the full dependency license list for the currently installed
versions:

```bash
pnpm dlx license-checker --production --summary
```
