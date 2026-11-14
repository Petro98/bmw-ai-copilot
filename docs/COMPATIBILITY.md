# Compatibility record

What is known about running BMW AI Copilot on the owner's car, split into three parts that
must not be mixed:

1. **Verified facts**: the implementing source file or official page was opened and the
   statement was seen in it. Each fact cites a repository, commit and path, or an official URL.
2. **Hypotheses**: believed, but not confirmed. Each says why it is believed and what would
   confirm it. Most are settled only on the car (see `docs/CAR_CHECKLIST.md`).
3. **Not possible or excluded**: things the design does not do, each with its evidence.

Written 2026-11-13 from the research record (ten reports and pinned copies of the reference
repositories). The research pass that was meant to cross-check every report claim did not
complete, so a report claim appears under *Verified* only when its source was reopened for this
document. Everything else is under *Hypotheses*, even when the reports call it verified.

## The car

BMW X3 xDrive30i, model year 2021 (to be confirmed by the owner); North-American specification
assumed (H-1). Head unit MGU (iDrive 7), firmware `P18_23w44.2-1-3`. The MGU Store was installed
by a service station; the owner manages the car through the Store only and does not hold root's
SSH key. Internet in the car comes from the owner's Android phone hotspot through the Store's uplink.
The vehicle identification number is never written in this repository.

## Sources

| Label | Repository | Commit | Licence (see 1.9) |
|---|---|---|---|
| A | `cauliflowermossgrape/idrive7-apps` (the MIT app kit, "kit A") | `4a8deb7` | MIT |
| B | `robertnisipeanu/mgu-store` (MGU Store, deploy tool, uplink, app-privacy) | `f4daf7a` | GPL-3.0 |
| C | `hexlay/idrive7-custom-apps` (M-Copilot) | `06ea119` | GPL-3.0-or-later, kit parts MIT |
| J | `JustAnotherPU/mgu-apps` (iDrive Monitor `jap_sysmon`, `jap-node22`, its own copy of the kit) | `main` as fetched on 2026-11-13; the research record did not note the commit | MIT |

A citation such as `A kit/tools/build.py:612-614` means repository A at the commit above, that
path, those lines. Paths in J are given as they are in the upstream repository.

---

## 1. Verified facts

### 1.1 Platform and lifecycle

| Fact | Evidence |
|---|---|
| Apps run on the head unit's system Node **8.16.2**; kit A's CI runs its runtime tests on exactly that version because "the head unit runs Node 8.16.2". | A `.github/workflows/app-tests.yml:102-110` |
| The package an app is built into declares `engines.node >= 8.7.0`; apps are CommonJS files, built by `kit/tools/build.py`. | A `kit/tools/build.py:607-610` |
| The "Node.js 22" component the owner has installed is `jap-node22`, Node 22 for the background services of other projects; "BMW's apps and MainApp keep the system Node 8; nothing here changes them." | J `tools/jap-node22/README.md:1-5` |
| On start the kit reports the app ACTIVE to MainApp "otherwise MainApp stops the app right after start", and on MainApp's `shutdown` event it exits with code 0 after 200 ms. | A `kit/runtime/mgu.js:544-550` |
| An uncaught exception is logged and ends the process (`process.exit(1)`); an unhandled promise rejection is only logged. | A `kit/runtime/mgu.js:80`, `kit/runtime/mgu.js:774` |
| Stock crash handling: when an app exits unexpectedly MainApp's `CorruptAppsHandler` wipes its data folder, and the second time uninstalls it. | A `README.md:515-518` |
| With the Store's `app-privacy` patch, a local-only app is restarted on every crash with its data kept; after 5 restarts within 10 minutes the next crash leaves it stopped until it is opened again or the next boot. A death while the head unit shuts down does not count. | B `native/app-privacy/README.md:82-92`, `native/app-privacy/patch_mainapp.js:195-196` |
| In kit J, MainApp keeps the two most recent inactive apps and stops the others; an app that stays ACTIVE is never stopped. A hidden app stays ACTIVE only while it holds a reason (`ctx.background(name, true)`). | J kit runtime files `life.js` (header comment) and `mgu.js` (the `background(name, on)` member of `ctx`); the fetched copies do not record their upstream paths |
| After a BMW firmware update the root file system is put back while `/var/opt` is kept: components stay listed, but their units, drop-ins and MainApp's per-app interface ACLs are gone until the install is run again. | B `deploy/README.md:1910-1916` |
| Kit A's movement convention: the car counts as moving above 3 km/h. | A `kit/runtime/parked.js:18`, `:29` |

### 1.2 Autostart and the pop-up precedent

| Fact | Evidence |
|---|---|
| Kit A turns `app.json` `"autostart": true` into `package.json` `"mguAppStartType": "autostart"`; kit J does the same from `"startType"`. | A `kit/tools/build.py:619-621`; J `kit/tools/build.py:427-428` |
| The Store's deploy tool accepts `autostart`, `lum` or `manually` (anything else refuses the package). An `autostart` app starts with the platform, is started again when it stops, and is never stopped for being inactive in the background. | B `deploy/README.md:1395-1401`, `deploy/unit/mgu-deploy.js:4095-4097` |
| In kit A, `impl.background(bg)` runs with `{ app, log, settings, signals, spec, dataDir }`; when the platform started the app without screens the kit logs "no screens for this start: running in the background" and builds no `ctx` (no UI). | A `kit/runtime/mgu.js:558-568` |
| **iDrive Monitor** (`jap_sysmon` 1.0.6, MIT) is an autostart app (`"startType": "autostart"`) that declares one pop-up `SYS_POP` of type `popUp` with widget `LT_State_PopupSmall`. | J `apps/jap_sysmon/app.json` |
| It raises that pop-up from its own rules, at most one per 10 minutes (`COOLDOWN_MS = 10 * 60000`), shows it for 8 s (`POP_MS = 8000`), holds it back while the gear stage is `R`, and must open the pop-up before setting its text ("text sent before the open is refused"). It keeps running hidden with `ctx.background('watch', true)`. | J `apps/jap_sysmon/main.js:1-14`, `:25`, `:84-92`, `:108-109` |
| Kit J's author tested it on a G05 with firmware `P18_23w44.2-1-3`, the owner's exact firmware string. | J `README.md:32` |

### 1.3 Resource limits

| Fact | Evidence |
|---|---|
| Kit A writes these per-app limits into the package unless `app.json` overrides them: `maxDiskUsage` 20971520 (20 MiB), `cpuLimit` 60, `memoryThresholdKB` 196608 (192 MiB), `priority` `PRIO_LOW`, `backgroundPriority` 200. | A `kit/tools/build.py:611-616` |
| The Store app itself runs at `cpuLimit` 30, `memoryThresholdKB` 131072 (128 MiB), `maxDiskUsage` 26214400 (25 MiB), `PRIO_MEDIUM`. | B `apps/robertn_store/package/package.json:7-14` |
| Kit J states that apps share 1000 MiB of memory; iDrive Monitor alerts when the apps reach 1300 MB of their cap. (The two figures disagree; see hypothesis H-5.) | J kit runtime file `life.js` (header comment); J `apps/jap_sysmon/main.js:7-9` |
| Every diagnostic request keeps the car awake: kit A's eDrive app reads only while driving plus 3 minutes, or 10 minutes after the user touched a page, "and the car can sleep". | A `apps/edrive/live.js:163-167` |
| Kit A's Ambient config, a headless autostart app, treats vehicle condition `<= 3` as "parked and left" and falls back to 15 minutes without use when the car reports no state. | A `apps/ambient_config/main.js:44`, `:92`, `:102` |
| The baseline manifest every kit A app gets grants `WakeUpOnDemand` (`registerParticipant`) and the NSM `RegisterShutdownClient` method. | A `kit/tools/build.py:61`, `:82` |
| The kit vendored here writes the same kind of baseline into our package's SOME/IP `manifest.json`: `PLATFORM_PROXIES` is copied into every manifest by `manifest_for`. Besides `"*"` (everything) on eleven interfaces (nine HMI, resource and use-case interfaces, the personalization `SessionManager` and the `OAPController`), the HMI's `UseCaseRegistry`, the read method `Provisioning.getValueJSON` and two read-only unit attributes (`Vehicle.statusNewCurrentUnitsStatusExt`, `EnvironmentalInformation.UnitBN2020`), it declares the wake-on-demand interfaces (`WakeUpOnDemand` `registerParticipant`/`unregisterParticipant`, `WodControl` `offerService`/`stopOfferingService`), the node-state consumer (`LifecycleRequestComplete`, `RegisterShutdownClient`, `UnRegisterShutdownClient`), other state-changing platform methods (`PrivacySettings` `addOrUpdateSetting`/`setDynamicAvailable`/`setDynamicEnable`, `Provisioning.setFilterForProvisioningData`, `PrivateEntryPoint` and `AppBookmarks` registration), the BMW account's identity attributes (`UserAccount` `firstName`, `gcid`, `id`, `name`, `type`) and `Lifecycle.powerStateDetailed`. | this repository, `car/kit/tools/build.py:38-71`, `:321-336` |
| Neither the kit's runtime nor our code calls any of the wake-on-demand, node-state, state-changing, account or power interfaces listed above. The runtime uses BMW's SDK only through `OnlineApp` and the SDK's logger: `start`, `initialized`, `registerActive`/`registerInactive`, `registerHmiVisible`/`unregisterHmiVisible`, `getLastExecutedEntryPointUuid`, `startReason`, its events, and the RHMI application it creates (screen states, entry states, resources). A test checks that our code and the bundle never name `WakeUpOnDemand`, `WodControl` or `RegisterShutdownClient`. Whether BMW's SDK calls any of the declared interfaces inside our process is not known: the SDK is not in this repository, and the kit's extractor lists an `NsmProxy` module among its files (H-27). | this repository, `car/kit/runtime/mgu.js:23`, `:30`, `:145-249`, `:493-512`, `:660-664`, `:685-697`, `:736-740`; `car/kit/runtime/life.js:36`; `car/test/bundle.test.ts:45-47`; `car/kit/tools/extract_sdk.js:33` |

### 1.4 Signals: passive versus diagnostic

"Passive" = a SOME/IP field subscription; no request reaches a control unit. "Diagnostic" = a UDS
or OBD request through the head unit's diagnostic gateway; it keeps the car awake. Scalings are
`value = raw × factor + offset`.

| Data point | Transport | Interface · field · member | Scaling and invalid value | Evidence |
|---|---|---|---|---|
| Engine speed | passive | `de.bmw.infotainment.vehicle.CDS` · `statusEngineSpeed2` · `actualValueRPMEngineCrankshaft` | × 0.25 rpm; 65535 invalid | A `kit/runtime/car.js:21-22`, `:115` |
| Vehicle speed | passive | `de.bmw.infotainment.vehicle.Vehicle2` · `statusCarSpeed2` · `speedVehicleCentreOfGravity` | × 0.015625 km/h; 65535 invalid | A `kit/runtime/car.js:23`, `:117` |
| Coolant temperature | passive | `CDS` · `statusEngineTemperature` · `temperatureEngineDrive` | − 48 °C; 255 invalid | A `kit/runtime/car.js:25`, `:116` |
| Engine oil temperature | passive | `CDS` · `statusEngineTemperature` · `temperatureEngineOilDrive` | − 48 °C; 255 invalid | A `kit/runtime/car.js:25`, `:116` |
| Gear and selector position | passive | `de.bmw.infrastructure.VehicleInformation` · `statusGearboxDrive` · `statusActualGearDrive`, `statusActualStageDrive`; fallback `DataPowerTrain2` · `statusGearSelectionDrive` ("some cars never send statusGearboxDrive") | enums: gear G1 = 3 … G10 = 12, R = 1, N_OR_P = 2; stage P = 1, R = 2, N = 3, D = 4 | A `kit/runtime/car.js:29-50`, `:123-136` |
| Vehicle condition | passive | `de.bmw.infrastructure.VehicleCondition` · `VehicleCondition` | 1–3 parked, 5 living, 7 ignition on, 8 drive readiness starting, 10 driving, 12 drive readiness ending, 15 no value | A `kit/runtime/car.js:36-42`, `:66` |
| Driving mode | passive | `de.bmw.infotainment.drivingexcitement.FES` · `statusFESVehicleDynamicSwitchHMI` · `actualValueModeDrivingExperience` | enum 1–10; 0, 61, 62, 63 no data | A `apps/live_data/signals.js:110` |
| Fuel in tank | passive (polled every 10 s) | `de.bmw.infotainment.KombiIF` · `statusRangeTankStatus` · `fluidLevelFuelTank` | litres; 255 and above invalid | A `apps/live_data/signals.js:28`, `:81` |
| Range | passive (polled) | same field · `range` | km; 4095 and above invalid | A `apps/live_data/signals.js:84` |
| Odometer | passive (polled) | same field · `mileageKilometre` | km; 16777215 and above invalid | A `apps/live_data/signals.js:85` |
| 12 V battery charge | passive | `CDS` · `statusBattery2` · `conditionBatteryChargingCondition` | percent, **not volts**; 151 and above treated as no data | A `apps/live_data/signals.js:120` |
| Tyre pressures and targets | passive (polled every 10 s) | `de.bmw.infotainment.vehicle.TPMS` · `statusTyrePressure`, `statusTargetTyrePressure` | × 0.1 **in the car's own pressure unit** (bar, kPa or psi from `Vehicle.statusNewCurrentUnitsStatusExt`); 65532 and above invalid | A `apps/live_data/signals.js:28`, `:128-132`; A `apps/car_vitals/app.json:772` |
| Tyre temperatures | passive (polled) | `TPMS` · `statusTyreTemperature` | − 40 in the car's temperature unit; 65535 invalid | A `apps/live_data/signals.js:130` |
| Service items (CBS) | passive | `de.bmw.infotainment.KombiInterface_2` · `cbsDataServiceList` (`cBSIdentifier`, `cBSServcieName` / `cBSServiceName`, `cBSColor`, `cBSServiceWay`, `cBSServiceDate`), `cbsDataSBA` | way and date are text already formatted by the car | C `apps/m_copilot/main.js:345-357` |
| Check Control | passive | see 1.5 | — | 1.5 |
| 12 V voltage | diagnostic only | UDS `22 F442` to the engine unit (candidate in kit A's tables) | — | A `apps/edrive/app.json:547` |
| Intake air temperature | diagnostic only | UDS `22 F40F` (= OBD PID 0F) to the engine unit (candidate) | — | A `apps/car_vitals/app.json:790-794` |
| Boost pressure (real) | diagnostic only | BMW identifier `580B` and others (candidates); the passive sport-display boost is marked as a guess (`q: true`) | — | A `apps/car_vitals/app.json:1016`; A `apps/live_data/signals.js:71` |
| Fault codes | diagnostic only | UDS `19 02 <mask>` sent to all units (`0xDF`); kit A uses mask `0x0C`, or `0xFF` for "all" | replies collected until 4 s of silence, hard stop at 25 s | A `apps/dtc_scanner/main.js:145-148`; A `kit/runtime/diag.js:107` |

None of these sources states a BMW threshold for any value. The design therefore ships no
numeric alert default (spec §7).

### 1.5 Check Control structure

| Fact | Evidence |
|---|---|
| Active messages come from `de.bmw.infotainment.checkcontrol.CheckControlMaster` · `basicList`: each entry has `ccmId`, `activeState` (`'AKTIV'` or `0` = active, anything else removes it), `requestorDiagAddr` (the unit that raised it) and `reason`. | A `apps/dtc_scanner/main.js:125-132` |
| Texts come from `de.bmw.infotainment.KombiInterface_2` · `ccList` and the `newCCMessage` event: `cCIdentifer` (BMW's spelling) or `cCIdentifier`, `cCShortName` or `cCName`, and `cCColor`. | A `apps/dtc_scanner/main.js:120-124`, `:133` |
| The structure is walked generically because it is not documented; when no text is known, M-Copilot names the entry "Check Control message <id>". | A `apps/dtc_scanner/main.js:114-119`; C `apps/m_copilot/main.js:214-231` |

### 1.6 Diagnostics safety

| Fact | Evidence |
|---|---|
| Kit A's `readonly-diag.js` keeps the real diagnostic link private (a `WeakMap`) and lets only `0x22` with 1–8 identifiers to one unit, OBD `0x01`/`0x09` with one PID, and `22 F1 50` to all units through; everything else throws, including sessions (10), reset (11), clearing faults (14), security access (27), communication control (28), writes (2E), I/O control (2F), routines (31), downloads (34–37), tester present (3E) and DTC settings (85). | A `kit/runtime/readonly-diag.js:1-60` |
| It does **not** allow `0x19`, so reading fault memory needs a deliberate, narrow extension (Plan 2 Task 5: exactly `19 02 <mask>` and `19 17 <mask> 01`). | A `kit/runtime/readonly-diag.js:35`, `:44-54` |
| Pacing: one request at a time, at least 25 ms apart, 1 s pause after "busy". | A `kit/runtime/readonly-diag.js:18-21` |
| Fault status byte: bit 7 = warning lamp requested (critical). | A `kit/runtime/diag.js:193-195` |
| M-Copilot reads only (`22`, OBD, `19 02 0C`), but through the unrestricted link, so read-only there is by convention. Our design does not reuse that link. | C `apps/m_copilot/main.js:714` (`d.functional(0x19, [0x02, 0x0C])` on the unrestricted link) |

### 1.7 Uplink (internet in the car)

| Fact | Evidence |
|---|---|
| `mgu-uplink` gives internet only to the uids it is told about, through a USB adapter, an LTE stick, a USB-tethered phone or Wi-Fi; the unit's own default route and resolver are untouched. | B `native/mgu-uplink/README.md:1-21` |
| Its firewall lets only the allowed uids out and lets **nothing connect in**. | B `native/mgu-uplink/README.md:16` |
| Allowed processes must resolve names through the lease's `dns` servers; the lease is in `/var/opt/public/oap/oap_<uid>/data/uplink.json` per allowed app, present only while online; offline connections fail with `EHOSTUNREACH`. | B `native/mgu-uplink/README.md:17-22` |
| An app is allowed by `"mguInternet": true` in its package. | B `deploy/README.md:1589`, `:1647` |
| Wi-Fi uplink is off by default, and joins on 2.4 GHz only by default (wireless CarPlay and Android Auto keep 5 GHz). | B `native/mgu-uplink/mgu-uplink.conf:30-40` |
| The head unit's clock "may be days off"; the Store's own updater therefore does not hold certificate dates against a certificate while checking everything else. | B `native/mgu-updater/README.md:585-592` |

### 1.8 Store publishing

| Fact | Evidence |
|---|---|
| BMW's `oap-sdk` is never in a repository; the head unit takes it from a stock BMW app already on it (a donor). | B `docs/PUBLISHING.md:23-26` |
| App ids are global on the head unit; a source must use its own prefix. | B `docs/PUBLISHING.md:27-30` |
| Nothing is signed: the owner trusts a source by adding it; the head unit fetches over HTTPS, with a token for a private repository. | B `docs/PUBLISHING.md:76-77` |
| A repository's own build runs on the head unit under Node 8.16.2 or Python 3.12, as an unprivileged uid, with no network, limited to 10 minutes and 200 MB. | B `docs/PUBLISHING.md:236-246` |

### 1.9 Licences of the reference projects

| Project | Licence | Evidence | What we may do |
|---|---|---|---|
| A `cauliflowermossgrape/idrive7-apps` | MIT | A `LICENSE:1-3` | copy with its notice |
| J `JustAnotherPU/mgu-apps` | MIT, with listed exceptions (third-party tools in its packages) | J `README.md:159-168` | copy the MIT parts with the notice; check each file against the exceptions |
| B `robertnisipeanu/mgu-store` | GPL-3.0 | B `LICENSE:1-2` | read as documentation of behaviour; do not copy code |
| C `hexlay/idrive7-custom-apps` | GPL-3.0-or-later; kit A's MIT notice kept in `LICENSE.MIT` | C `LICENSE:1-2`, `LICENSE.MIT:1-4`, `README.md:160-163` | read only; copying makes our code GPL |
| `JustAnotherPU/moonride` | GPL-3.0 (its README points to the GNU GPL v3 in `LICENSE`) | `README.md:92`, as fetched on 2026-11-13 (commit `d1073ce` according to the research record) | read only |

Licences of further projects named in the research are under H-20.

### 1.10 Claude API access

| Fact | Evidence |
|---|---|
| The Ultra plan includes $200 of Claude API credits a month (Max $100). They are claimed by linking one Claude Console organisation in claude.ai → Settings → Billing → API credits; no payment method is needed. | https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers |
| Credits expire at the end of each billing cycle with no rollover. When none are left, requests stop with "Your credit balance is too low to access the Anthropic API…" and usage is never charged to the plan. A workspace with its own spend limit caps one project. | https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers |
| Plan (OAuth) login is for ordinary use of Claude Code and Anthropic's own applications; developers building products "should use API key authentication through Claude Console". | https://code.claude.com/docs/en/legal-and-compliance (Authentication and credential use) |
| The Claude API offers Messages, Message Batches, Token Counting, Models, Files, Skills and the managed-agent APIs; no speech-to-text, text-to-speech or audio endpoint is listed. Requests carry `anthropic-version` (example `2026-10-21`). | https://platform.claude.com/docs/en/api/overview |
| The official TypeScript SDK installed in this repository is `@anthropic-ai/sdk` 1.8.0, which supports Node.js 20 LTS or later, so it cannot run on the head unit's Node 8. | `node_modules/@anthropic-ai/sdk/package.json:3`, `README.md:41`; https://github.com/anthropics/anthropic-sdk-typescript |
| M-Copilot already calls Claude from the head unit over raw HTTPS: `anthropic-version` `2026-10-21`, default model `claude-haiku-5-5`, `max_tokens` 2048, `output_config.effort` `low`, a refusal check, no streaming. | C `apps/m_copilot/ai.js:20-31`, `:617-631` |
| M-Copilot uses only characters 1–11 of the vehicle identification number; the serial part never leaves the car. | C `apps/m_copilot/vehicle.js:4-9` |

### 1.11 Ukrainian text on the head unit

| Fact | Evidence |
|---|---|
| Kit A's Cyrillic atlas has one size (48 px), 188 glyphs, 65 of them Cyrillic, and none of `і І ї Ї є Є ґ Ґ`, nor `’` (U+2019) or `ʼ` (U+02BC). Counted for this document by reading the atlas as data. | A `kit/localization/fonts/cyrillic-ru.json` |
| M-Copilot's text filter keeps only ASCII, a few symbols and Georgian and drops every other character, so Ukrainian would render blank. | C `apps/m_copilot/main.js:812-826` |

---

## 2. Hypotheses

Each entry: the claim; why it is believed; what would confirm it. "Report" means a research
report under `.research/reports/` whose citation was not reopened for this document.

**Car and platform**

- **H-1. The car is a BMW X3 xDrive30i, model year 2021, North-American specification, with a
  2.0-litre four-cylinder turbo petrol engine (B46/B48 family), 8-speed automatic, all-wheel
  drive.** Derived from the owner's data (spec §4). Confirm: the owner checks the registration
  papers. The engine type field (`Vehicle2.statusVehiclePartType.typeEngine`) is not declared by
  this version of the app, so it is not read on the car (checklist B6); C1 identifies the engine
  unit only after separate approval.
- **H-2. Some apps run on Node 8.9.4 (2019 units), not 8.16.2.** Reports `lifecycle.md`,
  `store.md` (D15), citing C's CI matrix. Confirm: the app's start line logs `process.version`
  (checklist B2).
- **H-3. An autostart app keeps receiving SOME/IP notifications with its screen closed and runs
  for hours.** Shipped precedents (Ambient config, iDrive Monitor) and kit comments. Kit A's
  headless path never calls `app.initialized()`; whether MainApp tolerates that over long runs is
  unknown (report `lifecycle.md`). Confirm: the app (autostart) for 60+ minutes, log lines
  (checklist B3).
- **H-4. An autostart app on this car gets an RHMI application (screens, pop-ups) at boot, as
  kit J's iDrive Monitor assumes, rather than kit A's screenless path.** Kit J raises the pop-up
  from `start(ctx)`; kit A logs "no screens for this start" when the SDK created none. Which path
  the owner's unit takes is not documented. Confirm: after a cold start without the tile being
  touched, the kit's `initialized (start reason …)` line, or its error line when the SDK created no
  screens (checklist B2); iDrive Monitor's "Test pop-up" after a head-unit restart.
- **H-5. The apps' shared memory cap is 1000 MiB** (kit J `life.js`), not the 1300 MB iDrive
  Monitor alerts on. Confirm: iDrive Monitor's "apps memory x of y MB" on the car.
- **H-6. The unit of `cpuLimit`, and what happens when it or `maxDiskUsage` is exceeded, are
  unknown.** Report `footprint.md`. Confirm: only by measurement; we stay at `cpuLimit` 30,
  `memoryKB` 131072.
- **H-7. Tapping the tile of a running autostart app may start a fresh process.** Report
  `lifecycle.md`. Confirm: a new start line in the app's log after a tap (checklist B4).
- **H-8. A merely running Node process does not delay head-unit sleep; how long the unit stays up
  after locking is unknown.** No measurement exists in any repository or tracker (reports
  `footprint.md`, `issues.md`). The app stays registered ACTIVE with MainApp for its whole life,
  parked included (`ctx.background('monitor', true)`, as iDrive Monitor does: this repository
  `car/src/app.ts:857`, `car/kit/runtime/life.js:27`); whether that changes when the unit sleeps is
  part of this hypothesis. Confirm: overnight shutdown time and 12 V with and without the app
  (checklist B16).
- **H-9. The `app-privacy` patch covers this unit's MainApp version.** It covers iDrive 7 MainApp
  8.3.2, 8.2.10, 8.1.1, 6.5.5 (report `store.md` D12, D15), and firmware `P18_23w44.2-1-3` was seen
  paired with MainApp 8.3.2 in a Store issue. Confirm: Store status shows the patch applied.

**Pop-up and screen**

- **H-10. Our pop-up shows over navigation or Android Auto, and BMW's own messages still win.**
  iDrive Monitor's pop-up is the only precedent; it was not observed over other screens in any
  source. Confirm: checklist A6 and B11.
- **H-11. BMW's pop-up widget and RHMI string slots render Ukrainian.** The HMI has a Ukrainian
  display language (report `audio.md` AUD-08), but nobody has shown Cyrillic in an app pop-up.
  Confirm: checklist B11 and B12. The test pop-up «Тестове сповіщення Copilot» shows `і`, and a
  pop-up from the car's own message starts «Авто повідомляє:», which shows `є`; `ї` and `ґ` appear
  in a pop-up only if a text the car sends contains them. The «Сповіщення латиницею» switch is the
  fallback.
- **H-12. The drawn screen needs the Store's GPU renderer with touch routing for tappable
  targets; the controller gate is not needed.** Report `ui.md` F8. Confirm: renderer listed in the
  Store; tapping a drawn target in an existing app works.

**Signals**

- **H-13. Which catalogue signals this G01 actually sends, and how often.** No G01 signal
  catalogue is published; kit A was developed on the owner's firmware family (report
  `telemetry.md` F14). `statusBattery2` is missing on some firmware; some cars never send
  `statusGearboxDrive`; TPMS and KombiIF may never notify. Confirm: which signals exist, from the
  kit's "this unit has no …" lines and the «Недоступно» tiles (checklist B6). How often they
  notify is not measured by this version of the app (B8).
- **H-14. Scalings are right for this car.** Kit A calls them "BMW's own (M Laptimer
  TypeConverters)"; the tyre pressure unit follows the car's display unit, and a
  North-American car may report psi, °F and miles. Behaviour in miles is unknown. Confirm:
  compare each value with the cluster in the car's own units.
- **H-15. Check Control `cCColor` values, text language and timing versus the cluster.** None is
  documented (report `telemetry.md` F13). The app maps red → critical, yellow or orange → warning,
  green or white → info (the reference's own Check Control colour table, A
  `apps/dtc_scanner/main.js:423`), and anything else, a wire number included, → warning (this
  repository `car/src/provider/raw-decoders.ts:358-371`). Confirm: car check B10, from what the
  СПОВІЩЕННЯ tab and the pop-up show; the raw colour values are not logged by this version.
- **H-16. The engine unit answers the diagnostic identifiers in kit A's candidate tables
  (`F442`, `F40F`, `580B`, `5813`, `4402`).** The tables were made for the Bosch MG1 family
  (B38/B48/B58) (report `telemetry.md` F4). Confirm: only after separate approval (checklist
  section C).
- **H-17. No report shows a pure `0x22` or `0x19` read restarting a unit; clearing faults has
  (DSC fault on a G01 X3 after "Clear all", `cauliflowermossgrape/idrive7-apps` issue 33).**
  Report `telemetry.md` F10. Confirm: not needed for phase 1; diagnostics stay disabled.

**Uplink**

- **H-18. Real uplink behaviour on this car**: time to "Online" after ignition-on, rejoin after
  sleep, audio skips with wireless Android Auto (several users report skips with wireless
  CarPlay: `idrive7-apps` issues 79 and 94, `mgu-store` issue 271, per report `issues.md`).
  Confirm: checklist A7 and A8.
- **H-19. Node 8's root store validates `api.anthropic.com` / our backend's certificate.** A live
  probe on 2026-11-13 saw a chain through GTS Root R4 cross-signed by GlobalSign Root CA until
  2028-01-28 (report `claudeapi.md`). The car app talks only to the owner's backend, whose
  certificate is the owner's choice. Confirm: TLS handshake from the car (checklist B14, with the
  head-unit clock from A4).

**Licences and ecosystem**

- **H-20. Further licences** (report `issues.md`, `audio.md`, not reopened):
  `cauliflowermossgrape/idrive7-8-ssh-root` Unlicense; `JustAnotherPU/ridetube` GPL-3.0;
  `IterioDev/car-apps` PolyForm Strict 1.0.0 according to one report and NOASSERTION according to
  another (treat as "do not copy"); `aurelmarius/bmw-test-apps` no repository licence;
  `WoodyCode23/woody-apps` NOASSERTION; `Vizualyse/idrive-apps` GPL-3.0. None of their code is
  used.
- **H-21. The ecosystem changes very fast and depends on one Store maintainer.** Store repository
  created 2026-10-27, 100+ component releases in 13 days (report `issues.md` Q8). Confirm: not
  applicable; mitigated by depending only on documented packaging fields.
- **H-22. Which "Tailscale" tool the owner has** (`iteriodev-tailscale` or the withdrawn
  `jap-tailscale`). Reports `store.md` D9 and `issues.md` disagree. The design does not use it.
  Confirm: Store → Installed.

**Claude API**

- **H-23. Per-model request rules** (Opus 5.5: thinking cannot be disabled, no sampling
  parameters, no forced `tool_choice`, no prefill; server-side refusal fallback only on models
  that support it). From the `claude-api` skill and report `claudeapi.md`; enforced and tested in
  Plan 1 Task 8. Confirm: the gateway's per-model tests and the opt-in evaluation script.
- **H-24. Ukrainian token counts and real latency over the hotspot.** Unknown (report
  `claudeapi.md`). Confirm: `count_tokens` on the real prompt; timing from the panel.

**Voice (phone side)**

- **H-25. Chrome on Android recognises `uk-UA` speech through Google's online recogniser and the
  phone has a Ukrainian `speechSynthesis` voice.** Report `voice.md`; no official per-language
  list was found. Confirm: `docs/VOICE_CAR_TEST.md` (Plan 3) and the checklist's voice items.
- **H-26. Which microphone Android uses while Android Auto is active, and how the car switches
  between media and call audio during capture.** Report `voice.md` (inferred). Confirm: in the car.

**Package manifest**

- **H-27. What the platform proxies the kit declares in our package manifest (1.3) allow on this
  unit, and whether the app starts without them, are not known.** Neither the kit's runtime nor our
  code calls them. The kit's build calls them "Platform proxies every OAP app needs (same set BMW's
  apps declare)" (this repository `car/kit/tools/build.py:37`), so removing them may break the
  app's start; what BMW's SDK does with them inside our process is also not known. Confirm:
  checklist B18, read with B5 and B16; ask the Store's author or the service station.

---

## 3. Not possible or excluded

| Item | Status | Evidence |
|---|---|---|
| **Cabin microphone** | Not possible with any known interface; excluded. | No project captures it: a search of A, B, C and related repositories found no capture code; the microphones reach the head unit as audio streams handled by BMW's audio router, and Moonride lists "no microphone" as a limit (report `audio.md` AUD-09, `issues.md` Q5). |
| **BMW speech engine (TTS or recognition)** | No interface known; excluded. | The SDK API recovered by kit A's extractor lists no speech or audio module, and no repository or issue uses one (report `audio.md` AUD-07). Ukrainian speech support on the unit is unknown. |
| **Taking over the steering-wheel voice button** | Excluded. | Apps see the voice button "but the HMI keeps acting on them too" (A `README.md:954-957`). Suppressing BMW's assistant would require hooking the HMI, which is interference. The button may be *observed* read-only (checklist C5, only after separate approval). |
| **Sound from the head unit** | Excluded by the read-only rule (spec §2); revisit only on the owner's explicit request. | Both known mechanisms (a PCM helper into the audio router, or BMW's media player) need state-changing calls into BMW's audio manager, displace the driver's audio source, and need a root-installed helper for PCM; untested on a G01 (report `audio.md` AUD-03 to AUD-05, AUD-15). |
| **Head-up display or instrument-cluster output** | Excluded. | A cluster-render experiment "restarted the instrument cluster twice" and showed brake, ABS and stability warnings and "Driver assistance restricted" (A `apps/redline/README.md:121-130`). |
| **Node 22 for our app** | Not possible for an app. | Apps run under MainApp on the system Node 8 (A `.github/workflows/app-tests.yml:102`); `jap-node22` is only for root "tool" services and "BMW's apps and MainApp keep the system Node 8" (J `tools/jap-node22/README.md:1-5`). Shipping a root tool is excluded: the owner has no root key and the design ships only an unprivileged app (spec §4). |
| **The official Claude SDK on the head unit** | Not possible. | SDK 1.8.0 needs Node 20 or later (1.10). Claude calls run in the backend. |
| **Driving the assistant from the subscription's login** | Not permitted. | Developers must use API keys (https://code.claude.com/docs/en/legal-and-compliance). |
| **An app listening for the phone over the uplink** | Not possible. | The uplink firewall lets nothing connect in (B `native/mgu-uplink/README.md:16`). The path stays car → backend → phone. |
| **Any write, coding, fault clearing, session change or actuator command** | Excluded by design (spec §2). | Write paths exist in reference apps and must never be copied: fault clear `14 FF FF FF` with extended session, CBS reset `2E 10 01`, xDrive writes `2E DB E1` (report `telemetry.md` F6, F10). Plan 2's diagnostic gate refuses them and ships disabled with no caller. |
| **Home-screen widget** | Not used. | It is rasterised in JavaScript and written to flash as PNG on every changed frame, ASCII-only text (report `ui.md` F5); against the storage-write budget. |
| **Anthropic speech API** | Does not exist. | No speech endpoint in the API overview (1.10). Phone-side speech is used instead (spec §8). |
