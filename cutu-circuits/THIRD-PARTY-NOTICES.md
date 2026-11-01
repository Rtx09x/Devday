# Source and dependency notices

Cutu Circuits incorporates existing implementation code. Exact inspected revisions are recorded in `sources.lock.json`; application dependencies are recorded in `package-lock.json`.

- `packages/ui` contains Rudra's Myui source with coordinated namespace changes. Its supplied `NOTICE.md` and `src/streaming-text.LICENSE` remain intact, including icon/font provenance. The collection does not grant a blanket open-source license.
- `packages/electronics-editor` incorporates the MIT-licensed electronics extension, retains `LICENSE` and `THIRD_PARTY_NOTICES.md`, and preserves its dependency patches.
- `packages/cad-editor` incorporates the MIT-licensed CAD extension and retains `LICENSE` and `THIRD-PARTY-NOTICES.md`. Dependency wrappers and the underlying OpenCascade kernel have their own terms.
- Makada firmware and reference control sources come from Rudra's robot repository. `examples/spidey/README.md` records provenance and distinguishes current firmware from referenced upstream gait research.
- The plugin's standalone bundle includes full bundled dependency license texts in `plugins/cutucircuits/dist/THIRD_PARTY_LICENSES.txt`.

Dependency license texts remain authoritative. Product renaming does not remove required notices or grant new rights to third-party materials.

The robotics workspace uses urdf-loader 0.13.1 (Apache-2.0, [upstream](https://github.com/gkjohnson/urdf-loaders)), the existing Rapier 3D compatibility bindings 0.12.0 (Apache-2.0, [upstream](https://github.com/dimforge/rapier.js)), and fast-xml-parser 5.11.2 (MIT, copyright 2017 Amit Kumar Gupta). Applicable full license texts are retained in `packages/robotics/licenses/`. The history comparison reuses diff 8.0.4 (BSD-3-Clause), already used by the source patching tool; its upstream license remains in the dependency and bundled license output where applicable.
