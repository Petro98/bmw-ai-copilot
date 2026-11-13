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
  `make_icon.js`, `oapgen/gen.js`, `pack_data.py`, `test_life.js`, `test_runtime.js`

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
  Korean routing, `has()` and a `?` width for a missing glyph, which we do not need now. Plan 2 Task 8 changes this
  file to route Cyrillic to the Ukrainian atlas and records it here.
- `runtime/locales/`, `localization/`, `icons/`, the other bake and test tools, `emu.js`.

Not vendored at all: `kit/renderd` (the GPU renderer, GPL-3.0-or-later), `kit/emu` (the emulator's WebAssembly draw
engine, GPL-3.0-or-later), any prebuilt binary, and from mgu-apps `tools/test_sysmon.js` (it tests mgu-apps' own
iDrive Monitor app, which is not here).

## Local changes

All in `tools/build.py`, each marked in the source with `[car/kit local edit N]`:

1. `--preview-only`: stages the app without BMW's `oap-sdk` and stops before the installable archives, for the
   offline preview; without the flag a missing `oap-sdk` stops the build with a message. Ported from idrive7-apps
   `kit/tools/build.py` at `4a8deb7` (the `preview_only` parameter, the SDK check, the early return, the argument).
2. `"mguInternet": true` in `app.json` is copied into the package's `package.json` (the MGU Store gives the app
   internet through mgu-uplink only then: mgu-store `docs/PUBLISHING.md`, "Internet"). Two lines.
3. `LICENSE.mgu-apps` is packed into every package as `LICENSE.kit-mgu-apps`, beside `LICENSE.kit`, so the vendor's
   notice travels with the code.

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
- `runtime/display.js`: without a renderer socket it checks for one every 5 s; after the first frame it keeps a
  500 ms keep-alive interval (unref'd). `signals.watch` with `pollMs` starts an interval that is never cleared.
- `runtime/mgu.js`: writes a rotating log file in the app's data folder, removes its own old frame files from
  `rhmiData/resources`, and exits the process when MainApp asks it to shut down or on an uncaught exception.
- `tools/oapgen/gen.js` (runs on the head unit at install time, never here) loads BMW's generator modules from the
  unit's firmware. `tools/extract_sdk.js` extracts BMW's SDK from an app on a head unit; it is never run for this
  project.
- `tools/preview.js` / `tools/hu-stub.js`: replace `require('./kit/mgu')` with the stub, evaluate the `Settings`
  class text of `runtime/mgu.js`, write PNGs into the output folder given (`car/preview/`) and exit after about 2 s.
