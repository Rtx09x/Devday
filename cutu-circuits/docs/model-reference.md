# Makada model reference

The assembly in `examples/spidey/model.replicad.ts` is a photo-informed reconstruction of Rudra's physical Makada, not a dimensioned scan. The supplied photograph is the primary appearance reference. It shows a compact bonded cluster of three blue micro servos, white plastic cross horns, irregular translucent hot-glue bonds, six long bent steel-wire legs and loose orange/red/brown leads. The user subsequently requested a NodeMCU at the back of the robot. A NodeMCU 1.0 ESP-12E is now modeled behind the cluster (+Y), standing upright in the XZ plane parallel to the servo backs. Its component side faces rearward (+Y), its antenna points +X and its USB points -X. Its mounting and component dimensions are illustrative estimates; the carrier outline follows the upstream library and the photograph does not measure or verify them. The landscape PCB occupies X=-24.13..24.13 mm, Y=21.5..23.1 mm and Z=42.8..68.2 mm. Its 48.26 mm width spans the servo cluster and its 25.4 mm height follows the servo backs. Header tails extend inward only to Y=16.3 mm, clear of the default cases ending at Y=14 mm. No mounting hardware or calibrated clearance through a real gait is claimed. A separate modeled external regulated servo power connector sits alongside the rear board.

## Primary construction reference

DmitryDzz, [Robot Beetle Ringo](https://www.instructables.com/Beetle-Ringo/), published 2014-02-24; inspected 2026-10-31. Full article text and image attachment URLs were read from the site's [article JSON](https://www.instructables.com/json-api/showInstructableModel?urlString=Beetle-Ringo).

- [Step 4: Beetles Tripod Gait](https://www.instructables.com/Beetle-Ringo/#step4) explicitly places **three servos in a row from left to right**. The left servo drives the left front/hind legs as one bent-wire part, the right servo does the same on the right, and the central servo tilts the two middle legs. This determines the three joints and coupled entities in the project graph.
- [Step 7: Assembling](https://www.instructables.com/Beetle-Ringo/#step7) directs the center output shaft horizontally, the side shafts upwards, the center cross horn horizontally and the side horns at 45 degrees. It specifies screws and trimming interfering inner horn arms. The model uses the corresponding shaft directions and white cross horns; trimming and precise spline indexing remain estimates.
- [Step 8: Making Legs](https://www.instructables.com/Beetle-Ringo/#step8) describes identical left/right front-hind wire parts, a separate center-leg stencil, correcting the center legs in plan to avoid collisions, hot-gluing the wires to the horns, and adding glue drops at the feet. The [marked side-leg photograph](https://content.instructables.com/FNO/187E/HS18BDE8/FNO187EHS18BDE8.jpg) was downloaded and visually inspected. Its raised angular knees, straight runs and connected front/hind shape support the construction used here.
- The article provides [side-leg stencil PDF](https://content.instructables.com/F8C/0OFI/HS18BDEO/F8C0OFIHS18BDEO.pdf) and [middle-leg stencil PDF](https://content.instructables.com/FL8/BVKG/HS18BDCK/FL8BVKGHS18BDCK.pdf). The direct endpoints returned empty bodies in this environment. Their existence and role are established by the article, but no dimensions were read from them.

The guide's original battery-holder chassis, Arduino Uno, IR receiver and tiny breadboard are not transferred into Rudra's assembly: his photograph and verified ESP8266 firmware take precedence.

## Estimated scale and parameters

A nominal SG90-sized case, approximately **23 × 12 × 29 mm**, anchors the scale. These dimensions identify a useful engineering envelope, not the exact servo manufacturer's drawing. All remaining placement is estimated from the photograph's proportions and perspective.

| Feature | Default estimate |
| --- | --- |
| Main blue cases | 23 × 12 × 29 mm nominal envelope, stepped lids/bearing included |
| Side-servo centers | 26 mm apart |
| Case bottom above ground | 43 mm |
| Side horn wire attachment | about 75 mm above ground |
| High side-wire knees | 109 mm above ground |
| Full foot span | 246 mm nominal, 248.6 mm with wire/foot radius |
| Front-to-hind foot stance | 206 mm nominal, 209.4 mm including glue feet |
| Steel-wire radius | 0.55 mm |

`wireRadius`, `bodyWidth`, `bodyHeight`, `legSpan`, `stanceLength` and `kneeHeight` change native solid geometry. The render uses the native kernel mesh buffers. Steel legs are circular profiles swept along angular OCCT wire paths; lead wires use smooth Bézier spines. Case mouldings, seams, horns, screws, glue bonds and feet are separate stable named shapes. The sideways middle casing is translated to Y=14 mm so its forward rectangular blue face is flush with the outer casings at Y=-11.5 mm. Its horn, middle-leg roots, authored motion pivot and URDF geometry use the same corrected placement; its shaft stays horizontal. The round output bearing necessarily extends beyond the rectangular casing face. Glue ellipsoids approximate the visible irregular blobs. Servo interiors, exact mould tooling, wire springback, glue deformation and connector pin details have not been measured or reverse-engineered.

The three output pivots are explicit `metadata.jointPivot` points on the servo entities. Servo bodies stay fixed while each joint rotates its horn, screw, glue, coupled legs and feet. The middle axis is horizontal along Y. Existing GPIO identities and pulse limits remain unchanged. The preview shows commanded pulse-derived angles only; no measured shaft feedback or validated walking dynamics is implied. Geometry parameter changes that move an output pivot require updating the corresponding authored graph pivot before interpreting a gait preview.

## Validation evidence

The actual OpenCascade worker compiled the revised model into **81 named shapes**, **42,510 triangles**. All 81 URDF mesh files were regenerated with `node --import tsx scripts/regenerate-spidey-meshes.mjs`. The NodeMCU and external power rail belong to the fixed body link, with estimated collision envelopes, mass and inertia. Physical header mesh coordinates are checked against the graph pin map, and PCB bounds verify the upright rear XZ plane, outward-facing components and clear header tails.

The existing printability analysis reports this multipart assembly as non-watertight and without a substantial flat print base, along with steep overhangs and an unset nozzle diameter. This reconstruction is an inspectable assembly/CAD reference; its compile and export checks do not establish a ready-to-print monolithic part.


## NodeMCU physical pins and power

`firmware/platformio.ini` selects `nodemcuv2`, which [PlatformIO defines as NodeMCU 1.0 (ESP-12E)](https://docs.platformio.org/en/latest/boards/espressif8266/nodemcuv2.html). The [upstream NodeMCU DevKit v1.0 pin map](https://github.com/nodemcu/nodemcu-devkit-v1.0/blob/master/Documents/NODEMCU_DEVKIT_V1.0_PINMAP.png) was visually inspected on 2026-11-01. Procedural geometry follows its two 15-pin rows. The upstream [ESP12E_DEVKIT.lbr](https://github.com/nodemcu/nodemcu-devkit-v1.0/blob/master/ESP12E_DEVKIT.lbr) was read to establish the 2.54 mm pitch, +/-11.43 mm row coordinates (22.86 mm spacing), and +/-12.7 by +/-24.13 mm carrier outline. Looking down at the component side with antenna up and USB down, the right row is D0, D1, D2, D3, D4, 3V3, GND, D5, D6, D7, D8, RX/D9, TX/D10, GND, 3V3. D5/GPIO14 drives LEFT, D6/GPIO12 drives RIGHT, and D7/GPIO13 drives TILT. Individual stable pin entities and orange signal leads terminate at the corresponding modeled physical pads; their nearby silkscreen labels are native CAD solids. All 30 pins are present. In the assembled upright landscape orientation, D5 is at [0, 24.6, 66.93] mm, D6 at [-2.54, 24.6, 66.93] mm and D7 at [-5.08, 24.6, 66.93] mm; the source pin order stays unchanged by the rigid rotation. Component packaging is simplified and not a manufacturing footprint.

The circuit source is a logical connection diagram with a six-port MCU symbol; its pinrow6 is not the physical NodeMCU footprint. The separate regulated BEC rail supplies all three red servo leads; brown leads share ground and a modeled ground jumper reaches NodeMCU GND. Neither 3V3 nor VIN supplies servo load. USB socket geometry does not imply a connected supply or validated USB/VIN current capacity. Controller power, real mounting and cable strain relief require hardware verification. No hardware was connected or actuated for this change.
