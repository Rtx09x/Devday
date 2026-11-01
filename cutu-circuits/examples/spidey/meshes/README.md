# Makada native visual meshes

These 81 binary STL files contain 42,510 triangles compiled by OpenCascade from the default parameters of `../model.replicad.ts`. Source SHA-256: `4175f6a363df0262744333457256c24cfe19bdb901ade10624d92d5dc8e7266e`. Total binary mesh size: 2,132,304 bytes.

Regenerate from the application root with `node --import tsx scripts/regenerate-spidey-meshes.mjs`. Each vertex is converted from millimetres to metres and translated into its URDF link's local pivot frame. Update the authored URDF pivots and collision geometry when changing mechanical placement.

These are photo-informed CAD meshes, not scanned or measured parts. The URDF uses separate estimated collision primitives, masses, inertia and joint limits. Wire/glue compliance, transmission backlash, servo calibration and measured hardware feedback are not modeled.
