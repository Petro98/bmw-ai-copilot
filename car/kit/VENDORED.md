# Vendored app kit

`car/kit/` is the MGU app kit: the runtime a head-unit app (Node 8.16.2, BMW iDrive 7 / MGU) is built with, and
the tools that package and preview it. It is third-party code under the MIT licence, copied into this repository
so that the MGU Store can build the app from this repository (`mgu-repo.json`). Our own code is in `car/src/` and
reaches the kit only through `require('./kit/<module>')` in the generated `car/apps/p98_copilot/main.js`.

Nothing of BMW's is here. BMW's `oap-sdk` is never vendored: the Store generates it on the head unit from an app
already installed there (`mgu-repo.json` `build.sdk`), and a local `car/oap-sdk/` is ignored by git.

## Sources

| Source | Licence | Commit |
|---|---|---|
| [JustAnotherPU/mgu-apps](https://github.com/JustAnotherPU/mgu-apps) `kit/` (itself the idrive7-apps kit, trimmed) | MIT: `LICENSE` (cauliflowermossgrape, 小白151) and `LICENSE.mgu-apps` (JustAnotherPU) | `3506f9454bc0adc43fa147cf955d85b36c45c6fb` (2026-11-08) |
| [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) `kit/`, for the files mgu-apps lacks | MIT: `LICENSE` (the same text, byte for byte) | `4a8deb7` |

Fonts: `runtime/fonts/{bold,label,light,num,gear}.json` are glyph atlases rasterised from the Ubuntu font family
(Ubuntu Font Licence 1.0, `runtime/fonts/UFL-Ubuntu.txt`); `runtime/fonts/cjk.json` is rasterised from Noto Sans SC
(SIL Open Font License 1.1, `runtime/fonts/OFL-NotoSansSC.txt`). Both licence texts ship beside the atlases in
every package (`build.py` copies `runtime/` whole).

## Files and where each comes from

From mgu-apps `kit/` at the commit above, unchanged unless listed under "Local changes":

- `LICENSE`
- `platform/permissions.json`
- `runtime/`: `canvas.js`, `car.js`, `credits.js`, `display.js`, `fonts.js`, `gauges.js`, `hmi-text.js`, `i18n.js`,
  `life.js`, `locale.json`, `mgu.js`, `record.js`, `renderd.js`, `sheet.js`, `signals.js`, `sim.js`, `themes.js`,
  `fonts/` (`bold.json`, `cjk.json`, `gear.json`, `label.json`, `light.json`, `num.json`, `OFL-NotoSansSC.txt`,
  `UFL-Ubuntu.txt`)
- `tools/`: `bake_fonts.py`, `build.py` (changed, below), `extract_sdk.js`, `locale-revisions.json`, `localize.py`,
  `make_icon.js`, `oapgen/gen.js`, `pack_data.py`, `test_life.js`, `test_runtime.js` (cases added, below)

`LICENSE.mgu-apps` is mgu-apps' own root `LICENSE` (JustAnotherPU), unchanged.

Ported from idrive7-apps `kit/` at `4a8deb7` (absent from mgu-apps), unchanged:

| File | Why |
|---|---|
| `tools/preview.js` | the offline preview: runs the staged app against `hu-stub.js` and saves each drawn frame as a PNG (`car/scripts/preview-car.sh`) |
| `tools/hu-stub.js` | the stubbed head unit `preview.js` loads (no SDK, no SOME/IP) |
| `tools/bake_cyrillic.py` | the template for baking a Cyrillic glyph atlas (Plan 2 Task 8 writes `bake_ukrainian.py` from it). As shipped it reads `kit/runtime/locales/ru.json` and `build_diagnostic_ru.py`, which are not vendored, so it does not run here unchanged |
| `runtime/parked.js` | "parked only" from `Vehicle2.statusCarSpeed2` (read-only `signals.watch`); reference for the power gate |
| `runtime/readonly-diag.js` | the kit's read-only diagnostic allow-list, kept as reference for Plan 2 Task 5. Its transport, `runtime/diag.js`, is deliberately **not** vendored: `require('./kit/readonly-diag')` fails, so this file cannot send anything. Nothing requires it |

Compared and not ported:

- Cyrillic font routing (`runtime/fonts.js`): mgu-apps' `fonts.js` already routes text with characters in
  U+0400–U+04FF to a `cyrillic` atlas (and falls back to `label` while there is none). idrive7-apps' version adds
  Korean routing, `has()` and a `?` width for a missing glyph, which we do not need. Plan 2 Task 8 routes Cyrillic
  to the Ukrainian atlas instead (local edit 5).
- `runtime/locales/`, `localization/`, `icons/`, the other bake and test tools, `emu.js`.

Not vendored at all: `kit/renderd` (the GPU renderer, GPL-3.0-or-later), `kit/emu` (the emulator's WebAssembly draw
engine, GPL-3.0-or-later), any prebuilt binary, and from mgu-apps `tools/test_sysmon.js` (it tests mgu-apps' own
iDrive Monitor app, which is not here).

## Local changes

Edits 1-3 and 8 are in `tools/build.py`, edit 4 in `runtime/signals.js`, edit 5 in `runtime/fonts.js`, edit 6 in
`runtime/mgu.js`, edit 7 in `runtime/display.js`, edit 9 in `runtime/display.js` and `runtime/mgu.js`; each is marked
in the source with `[car/kit local edit N]`, and so are the cases `tools/test_runtime.js` gained for edits 7 and 9:

1. `--preview-only`: stages the app without BMW's `oap-sdk` and stops before the installable archives, for the
   offline preview; without the flag a missing `oap-sdk` stops the build with a message. Ported from idrive7-apps
   `kit/tools/build.py` at `4a8deb7` (the `preview_only` parameter, the SDK check, the early return, the argument).
2. `"mguInternet": true` in `app.json` is copied into the package's `package.json` (the MGU Store gives the app
   internet through mgu-uplink only then: mgu-store `docs/PUBLISHING.md`, "Internet"). Two lines.
3. `LICENSE.mgu-apps` is packed into every package as `LICENSE.kit-mgu-apps`, beside `LICENSE.kit`, so the vendor's
   notice travels with the code.
4. `runtime/signals.js` `watch()` (lines 60-70 and 88): a polled watch (`opts.pollMs`) could not be stopped. Upstream
   calls `setInterval` without keeping the handle, and `res.shutdown` neither clears it nor resets `res.available`,
   so after a shutdown the interval kept firing for the life of the process (a timer while the car is parked, which
   spec §9 forbids, and one more for every start of the provider). Now the handle is kept in `pollTimer`;
   `res.shutdown` clears it, sets `res.available = false`, and shuts the proxy down only on its first call, so
   shutting down twice is harmless. Tested with a fake native binding in `car/src/provider/kit-signals.test.ts`.
5. `runtime/fonts.js` (lines 27-31, 37, 53-63): text with Cyrillic (U+0400–U+04FF), `№`, `ʼ` or the placeholder `□`
   goes to the Ukrainian atlas `fonts/cyrillic-uk.json` (below), falling back to upstream's `cyrillic` and then
   `label` when that file is absent; a new export `has(cp)` says whether that atlas (else `label`) has a glyph, so the
   screens draw `□` for a character no atlas has instead of the kit dropping it silently
   (`car/src/ui/theme.ts` `fitText`). Tested in `car/test/atlas.test.ts` against a copy laid out as in a package.
6. `runtime/mgu.js` `ctx.loop` (lines 587-625), for spec §9's budget (one screen frame only when something changed,
   a few log lines per drive):
   - the "loop …: N ms per frame" line, upstream `log.info` every 100 frames (software) or 600 (GPU), is
     `log.debug` (kept out of the log file unless `MGU_DEBUG` is set);
   - the GPU path honours the requested fps. Upstream ran the app's function on every renderer tick and, when
     the frame was unchanged and not sent, re-armed a 16 ms timer: up to 60 turns a second whether or not the app
     drew. Now both paths run about `fps` turns a second (`setTimeout(tick, max(15, 1000 / fps - dt))`), and a
     renderer tick only schedules the next turn when none is pending. The screen asks for 4.
   `tools/hu-stub.js` keeps upstream's copy of the loop for the emulator (`liveLoop`, not used by the preview).
7. `runtime/display.js` (lines 109-119, 156, 165-167, 169-172, 183-189, 214-215, 225-244, 811-830, 850-851), so nothing of
   the display runs while the screen is hidden, it logs nothing periodically, and the kit never takes the iDrive
   controller (spec §6.4: no controller gate, no controller grab):
   - the renderer keep-alive interval (500 ms; it re-sends the last frame at least once a second, or the
     renderer hides a quiet app) runs only with a renderer connected and the screen shown (`_startKeep`). It stops
     when the screen is hidden and starts again when the screen shows with a frame to keep, or with the next
     frame; upstream started it with the first frame of any path and never stopped it. (Starting it only with a
     sent frame was not enough: after a short hide the app's first frame is identical, is not sent, and the
     renderer would have had no frame until the picture changed.)
   - `_grab()` holds the controller only when the app asks (`ctx.controller.grab`, which this app never calls).
     Upstream also held it whenever the kit runs the screen (full-screen layout) and the renderer reports the
     controller gate, shown or not, and `runtime/renderd.js` re-sends the grab every 500 ms while it holds.
   - no renderer client exists while the screen is hidden unless its connection is up: `_mode` starts one only
     while the screen shows (an autostart app starts hidden, and a change of the 'renderer' setting may come while
     it is hidden), and a client is let go (`_dropGpu`) when its connection is not up at the moment the screen is
     hidden, or when the connection is lost while it is hidden. Otherwise `runtime/renderd.js` (unchanged) retries
     every 3 s for the life of the process, also against a stale socket file or a renderer that drops the
     connection. The screen showing again looks for the renderer (`_mode`); the layer-drop handler is registered
     once, so starting a client again adds nothing. (`MGU_RENDERD_FILE`, the testing stream to a file, starts at
     once as upstream: it has no connection to retry.)
   - without a renderer socket, the 5 s look for one runs only while the screen shows (and starts again when it
     is shown); the "no mgu-renderd socket" line is said once;
   - the "display: N fps sent" line, upstream `log.info` every 10 s while frames are sent, is `log.debug`.
   The kit's own `node car/kit/tools/test_runtime.js` (the unchanged-frame skip and its one-a-second keep-alive
   among them) still passes, and has four cases for this edit on the same stand-in renderer (its stand-in now
   also counts connections and records each message's type): the keep-alive only while the screen shows and only
   with a renderer; the keep-alive going on after a short hide and show; no controller grab by the kit (no grab
   timer, no `GRAB` message) while an app that asks still gets it; no renderer reconnect while hidden (lost while
   hidden, unreachable then hidden, an app that starts hidden), and the renderer found again once shown. Undoing
   any one of the four changes above makes its case fail.
8. `tools/build.py` (lines 485-488): the Ukrainian glyph atlas `localization/fonts/cyrillic-uk.json` and its
   licence notice `localization/fonts/UFL-Ubuntu.txt` are copied into every package's `kit/fonts/`, where
   `runtime/fonts.js` reads the atlas (edit 5). Upstream copies `localization/fonts/` only for a Russian build, so
   the installable package had no Ukrainian atlas and every Cyrillic string would have been drawn blank on the
   car. Tested in `car/test/package.test.ts` (the staged package, and its `kit/fonts.js` drawing `Ї` and `□`).
9. The kit's own words on the screen, in Ukrainian like the app's (the plan's rule for interface copy):
   `runtime/display.js` `_tabList` (lines 259-260) names the header's Settings tab «Налаштування» (upstream
   'Settings'); `runtime/mgu.js` `Settings.display` (line 126) gives a switch's value as «Увімкнено» / «Вимкнено»
   (upstream 'On' / 'Off'), and the settings sheet is opened with the title «Налаштування» (line 467; upstream
   `null`, which `runtime/sheet.js` makes 'Settings'). The kit's language mechanism (`build.py --language` with a
   `runtime/locales/<tag>.json` catalog through `runtime/i18n.js`) was not used: the catalogs are not vendored,
   the MGU Store builds with `build.py {id}` only (`mgu-repo.json`), and a non-English build renames the package
   version (`0.1.0-uk.1`, `tools/localize.py` `package_version`), which no longer matches the Store's
   `car/dist/{id}@{version}.tgz`. Tested in `tools/test_runtime.js`. `runtime/sheet.js` still draws 'Version …',
   'Done', 'Back' and 'Close' in English (not changed here).

## Fonts and code added for this project (Plan 2 Task 8)

- `tools/bake_ukrainian.py` (ours, MIT like the rest; written from `tools/bake_cyrillic.py` and `tools/bake_fonts.py`
  as templates) bakes `localization/fonts/cyrillic-uk.json`: sizes 22, 30, 40, 54 px, 1024 px wide, at most 727 px
  tall (the kit's limit is 2048), with the Latin of `bake_fonts.py` `TEXT`, the Cyrillic block U+0400–U+045F, `Ґ ґ`,
  `ʼ ’ № « »` and a drawn `□`; a character the font lacks is left out rather than baked as its `.notdef` box
  (Ubuntu 0.83 lacks `│ ↑ ↓ → ← ✓ ✕`), and a missing Ukrainian letter stops the bake. It needs Pillow and was run
  with the system's Pillow 11.3.0:
  `python3 car/kit/tools/bake_ukrainian.py <dir>/Ubuntu-Regular.ttf`.
- The font: Ubuntu Regular, version 0.83 (Copyright 2011 Canonical Ltd., Ubuntu Font Licence 1.0), downloaded once
  from Google Fonts' repository, `https://raw.githubusercontent.com/google/fonts/bed55e0de5cfa8f5fb94f9a1f49409b5ec504469/ufl/ubuntu/Ubuntu-Regular.ttf`
  (SHA-256 `3128df86a31805618436d0ae5651ba4285d0c9de0a39057d025f64ee33bceb64`), into a scratch folder, never
  into the repository. Only the baked atlas is committed, with the licence next to it:
  `localization/fonts/UFL-Ubuntu.txt` (byte for byte the same as `runtime/fonts/UFL-Ubuntu.txt` and the `UFL.txt`
  of that Google Fonts folder).
- The package: the kit's `fonts.js` reads the atlas from `kit/fonts/cyrillic-uk.json` in the package; `tools/build.py`
  puts it there, with its licence notice, in every build (local edit 8), and `car/scripts/preview-car.sh` checks it
  is there.
- QR code generator: `car/src/ui/qr-nayuki.ts` is Project Nayuki's QR Code generator library (MIT,
  `Copyright (c) Project Nayuki`), `typescript-javascript/qrcodegen.ts` of
  https://github.com/nayuki/QR-Code-generator at commit `8329a7108fc22be3e1eec0a9f9318978579e3621`
  (SHA-256 of the file as fetched `1dc03fb5a10e0e2318ea162755bbdb9977ca6ce52cff959e9c9b6deafdccda9c`), read in
  full before it was copied. Unchanged except for four comment lines and `/* eslint-disable */` at the top and
  `export { qrcodegen };` at the end; its MIT notice is kept in the file.

## What the kit does that matters for this project (read before the first run)

The kit was read before any of it ran here. Things it does beyond drawing:

- `tools/build.py`: writes only under `car/dist/` (ignored by git). It downloads files only for an `app.json`
  `"assets"` entry (`fetch_assets`, `urllib`; our app has none) and shells out to `node tools/make_icon.js` only
  when an app has no `icon.png` (ours has one). It declares, in every app's SOME/IP `manifest.json`, the platform
  proxies BMW's own apps declare (`PLATFORM_PROXIES`), among them `WakeUpOnDemand`, `WodControl` and the NSM
  consumer with `RegisterShutdownClient`: the SDK's lifecycle uses them; our code never does.
- `runtime/signals.js`: besides `watch` (read), it exports `set`, `call`, `proxy` and `on`, which can write fields
  and call methods on vehicle interfaces. Our code never uses them, and `car/src/kit/kit.d.ts` does not declare
  them. A field is writable only with `w` in its `app.json` flags (`r` read, `s` subscribe, `w` write); ours never
  has one (`car/test/bundle.test.ts`).
- `runtime/renderd.js`: connects to the GPU renderer's local Unix socket (`/run/mgu-renderd/renderd.sock`,
  `/run/mgu-render/render.sock`) when one exists; no network.
- `runtime/display.js`: without a renderer socket it checks for one every 5 s while the screen shows; with a
  renderer it keeps a 500 ms keep-alive interval (unref'd) while the screen shows; it never takes the iDrive
  controller on its own and keeps no renderer connection that is not up while the screen is hidden (local edit 7;
  `tools/test_runtime.js` has a case for each). `signals.watch` with `pollMs` starts an interval that the watch's
  `shutdown()` clears (local edit 4; upstream never clears it).
- `runtime/mgu.js`: writes a rotating log file in the app's data folder, removes its own old frame files from
  `rhmiData/resources`, and exits the process when MainApp asks it to shut down or on an uncaught exception.
- `tools/oapgen/gen.js` (runs on the head unit at install time, never here) loads BMW's generator modules from the
  unit's firmware. `tools/extract_sdk.js` extracts BMW's SDK from an app on a head unit; it is never run for this
  project.
- `tools/preview.js` / `tools/hu-stub.js`: replace `require('./kit/mgu')` with the stub, evaluate the `Settings`
  class text of `runtime/mgu.js`, write PNGs into the output folder given (`car/preview/`) and exit after about 2 s.
