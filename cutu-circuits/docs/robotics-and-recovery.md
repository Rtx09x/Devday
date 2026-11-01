# Robotics and recoverable editing

This stage adds real articulated simulation and recoverable authoring while retaining the existing Myui workspace. Robot tools are contextual; history and source comparisons open only when requested.

## URDF and physics

Create a project using **Robot · URDF + physics**, or open a URDF asset from the project files. New Makada projects include **Articulated Makada**, with 40 STL meshes generated from the photo-informed native CAD. The example arm has a revolute shoulder and prismatic extension. Both examples are editable native files.

**Inspect** moves joints through forward kinematics with their authored limits. **Physics** creates an actual Rapier rigid-body world. Play, pause, single step and reset control the solver. Settings expose fixed/free base, gravity, ground contact, collision geometry and model diagnostics. Joint targets and simulated positions are separate: a link touching the floor may prevent a requested pose. No simulation action connects to a physical board.

The implementation reuses [URDFLoader](https://github.com/gkjohnson/urdf-loaders) for the visual hierarchy and [Rapier](https://rapier.rs/) for dynamics. The physics package uses SI metres, kilograms, seconds and radians, with Z up. The existing CAD/project layer uses millimetres; mesh conversion is explicit.

Supported URDF joints are fixed, revolute, continuous and prismatic. Authored origins, axes, limits, centre of mass and full symmetric inertia tensors are validated. Primitive collision boxes, spheres and cylinders are supported; STL collisions use convex hulls. Visuals support local STL and DAE. Relative resources resolve beside the URDF; `package://pkg/meshes/link.stl` resolves to `pkg/meshes/link.stl` inside the project. External URLs, absolute paths, traversal outside the project and private runtime records are not robot resources.

Use **Workspace actions → Import URDF** to select a native XML file, choose its project path and register its Robot asset. The import creates a new file and never overwrites an existing one. Referenced meshes and textures must already be in the project folder. Codex can discover that folder with `project_environment` and add companion files through its terminal tools. Preserve ROS package directories when using package URLs.

## Model assumptions

Makada is a rigid-body approximation of the photographed robot, not a calibrated dynamic twin. Its native visual meshes follow the CAD reference; link masses, inertias, friction and joint bounds remain estimates. The interface exposes those assumptions. The three actuators drive coupled wire pairs; deformation of wire, hot glue and plastic is not simulated.

Motor position targets obey joint bounds, but the model does not implement measured servo torque/current, saturation using URDF effort ratings, multi-turn continuous-joint tracking, controllers/transmissions or general closed chains. Unsupported joint/mimic/calibration features fail validation. DAE visuals work with primitive or STL collisions; DAE collision meshes are unsupported. Missing inertia or collision geometry produces explicit estimates and diagnostics. Floor contact is ideal rigid contact, not proof of walking stability, clearance, power integrity or stop performance on hardware.

URDF input is limited to 1 MiB and 128 links. Rendering resources are limited to 16 MiB each. Headless simulation runs in disposable processes, accepts up to 10 simulated seconds per call, and has a 10-second computation deadline and a two-job concurrency limit. Renderer-backed physics runs locally in the browser and pauses when its document is hidden.

## Version history

Open **Workspace actions → Version history**. Choose a native file, inspect an immutable version, compare its contents with the current saved file, and restore it as a new revision. The current saved content remains in history. Restoration requires the exact observed source SHA; a newer external save causes a conflict instead of being overwritten. Unsaved editor drafts block restoration until they are handled in their owning editor.

The runtime retains content it saves and external versions it actually observes. It cannot reconstruct terminal edits made before observation. Private history is excluded from normal project file listings. It is local project storage, not a remote backup or credential vault, and currently has no automatic retention pruning.

## Interrupted writes

A durable intent record and immutable recovery content are written before replacing native source. The intended source and project manifest commit through separate guarded replacements. On restart, or before a subsequent mutation, the runtime reconciles known before/after states. If the source committed but metadata did not, matching metadata can be completed. If disk still matches the original state, the prepared attempt is abandoned and retained as recovery history.

Unknown terminal edits are preserved; conflicting intent is archived under `.cutucircuits-transaction-conflicts`. Source/history evidence remains available instead of silently choosing a winner. Malformed external manifests may require terminal repair. Importing a URDF and registering its asset uses this same journal.

This is recoverability, not an atomic multi-file database transaction. A noncooperating writer can still race the final hash check and rename. Directory durability depends on filesystem support; multiple runtime processes sharing one data directory are not protected by a cross-process lock. Run one broker per data directory and use source/version guards for coordinated edits.

## Codex tools

The plugin now exposes 26 tools. New tools are `list_file_history`, `read_file_version`, `restore_file_version`, `import_urdf`, `inspect_robot` and `simulate_robot`. Codex can edit a URDF, inspect its real model, run bounded dynamics, read numerical poses/contacts/diagnostics and restore an earlier source version through the same runtime as the interface. These tools neither simulate an agent conversation nor claim an installed client or connected board.
