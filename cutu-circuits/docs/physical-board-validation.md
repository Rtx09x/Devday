# Physical controller commissioning — 1 November 2026

The user connected the previously walking robot by USB and confirmed the servo/LiPo supply was disconnected. The Silicon Labs CP2102 initially had Windows Code 28 (missing driver). An official Microsoft Update Catalog driver with a valid Microsoft Windows Hardware Compatibility Publisher signature was installed with administrator approval. The board then appeared on COM11.

Read-only identification confirmed ESP8266EX, 26 MHz crystal and 4 MB flash. A complete 4,194,304-byte flash backup was read and verified before modification. It is stored only in ignored private local storage because the binary may contain credentials.

The actual EEPROM location was confirmed using the `nodemcuv2` linker and compiled symbol: physical offset `0x3fb000`. Saved calibration and timing records had valid checksums; all three directions were configured. These are saved device settings, not a fresh measurement of physical clearance or servo angles.

With the user's choice of fresh credentials, a private 2.4 GHz laptop hotspot and random command token were configured. The exact updated SNAPSHOT source was built with a separate private header. Correct `nodemcuv2` firmware was uploaded without erase-flash and the written data hash verified. The upstream repository's root project is an older motor experiment and was not used.

After upload, authenticated reads verified STATUS, SNAPSHOT, all three CONFIG records and TIMING. Every calibration and timing value matched the pre-upload backup. STATUS reported calibrated, running=0 and enabled_mask=0; STOP was acknowledged. The prepared Makada Demo project received its connection configuration only in hidden `.local/wifi.json`.

The actual workspace monitor received fresh atomic snapshots at approximately 9 Hz with a 10 Hz requested polling rate. Outputs remained detached, and no ENABLE, JOG or RUN command was issued. The user initially asked to wait before motion, and subsequently explicitly authorized centering and walking. The owner confirmed visible centering. A complete 50-cycle plan was verified as 20 + 20 + 10; later longer requests stopped early on Wi-Fi timeouts, including a 100-cycle attempt with 40 cycles confirmed. The controller is battery-powered during wireless operation. All movement requests used Wi-Fi; USB was used for flashing and identification only. Software snapshots describe commanded pulses, not measured shaft positions or actual distance travelled.

Private credentials, binaries, flash backup and installation logs are excluded from source submission packaging. Detailed credential-free local readback proofs are under `.tools/drivers/`; do not distribute the private flash backup or private connection files.

The later in-workspace Walk forward UI and 1–100 cycle batch planner were verified with fake TCP devices and browser fixtures, without issuing a new physical motion command during that implementation. End-to-end wireless reliability remains a material demo limitation.
