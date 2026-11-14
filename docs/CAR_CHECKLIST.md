# Car checklist

Every check that can only be settled on the owner's car: a BMW X3 xDrive30i, model year 2021 (to
be confirmed by the owner; North-American specification assumed, H-1), MGU head unit (iDrive 7),
firmware `P18_23w44.2-1-3`, MGU Store installed by a service station.

The list merges the spec's car checks (§12) with the "car checks" of the ten research reports,
with duplicates removed. Each check says what to do, what to record, why it matters, and what
approval it needs. The hypotheses it settles are numbered in `docs/COMPATIBILITY.md` (H-n).

## Ground rules

- **The owner performs every step.** Nothing is installed on, sent to or run against the car by
  the project or by an agent.
- **Every install needs the owner's confirmation, each time.** Read what the app does first.
- **Parked and safe.** Unless a check says "while driving", do it parked, in a safe place, with
  the parking brake on. Checks marked "while driving" are observed by a passenger or read from a
  log afterwards; the driver does not operate the phone or the iDrive screen for them.
- **Stop at once** if any BMW warning, Check Control message or unusual behaviour appears that
  the check did not intend; note it and do not continue that check.
- **Never write a vehicle identification number, a key, a token or an address** into the notes
  that go into this repository.
- Keep the results in a private notes file; the facts that matter are copied into
  `docs/COMPATIBILITY.md` afterwards (moved from *Hypotheses* to *Verified*, with the date).

### Approval levels

| Mark | Meaning |
|---|---|
| **None** | Observation only: looking at screens, the Store, the iDrive Monitor, the clock. Nothing is installed or changed. |
| **Install** | Installs or updates an app through the Store. The owner confirms that install, as for every install. |
| **Separate** | Needs a separate, explicit approval by the owner for that check, in addition to any install confirmation. All checks that touch diagnostics or audio are in section C. |

---

## A. Before any of our code is installed

### A1. Store inventory

- **Do:** open the Store → Installed, and Store → Settings → sources.
- **Record:** id, version and source of every app and tool, in particular `jap-node22` (expect
  22.23.4), `jap_sysmon` (iDrive Monitor), the Tailscale tool (`iteriodev-tailscale` or
  `jap-tailscale`), the renderer (`idrive7-renderd` or `mgu-render`), `mgu-inputgate`,
  `mgu-uplink`, `app-privacy`, `mgu-deploy` (0.8.16 or later has safe mode), `mgu-updater`,
  `mgu-python`, the Store itself (owner reports 0.9.39); whether the status line shows "Safe
  mode"; every source and its channel; any installed app that can write to the car (for example
  engine or xDrive configuration, exhaust flap, seat or wheel heating control, a fault scanner
  with "Clear").
- **Why:** confirms what the design builds on (renderer, uplink, app-privacy, deploy version),
  and shows whether write-capable software is already on the unit, which the owner may want to
  remove to keep the car read-only (open decision 9 in `ROADMAP.md`). Settles H-9, H-22.
- **Approval:** None.

### A2. Questions for the service station

- **Do:** ask the service station that installed the Store.
- **Record:** whether they keep root's SSH key for this car; whether SSH is still enabled; their
  procedure before and after a BMW software (I-step) update; whether Remote Software Upgrade is on
  in the car; whether a coding backup exists.
- **Why:** a BMW software update removes the Store's root-side setup and the apps stop starting;
  re-installation needs root access the owner does not have. The Store's author recommends
  uninstalling before an update; a re-install once caused a boot loop (fixed since). The owner
  needs a plan before any update, with a battery charger connected.
- **Approval:** None.

### A3. Head-unit and car identity

- **Do:** iDrive → Settings → General settings → software / version information; the Store's
  settings page; the car's documents.
- **Record:** firmware string (expect `P18_23w44.2-1-3`), MainApp version (expect 8.3.2), hardware
  variant if shown (`mgu-high` or "ID7 Lite"), centre display size (10.25" or 12.3"), audio system
  (standard, HiFi, Harman Kardon; information only), head-up display fitted (information only;
  never used), Android Auto wired or wireless, and the units the car displays (°C or °F, bar,
  kPa or psi, km or miles, litres or gallons).
- **Why:** screen layout and touch sizes depend on the display; a North-American car may report
  US units, and every value is read together with the car's unit setting; confirms H-1 in part.
- **Approval:** None.

### A4. Head-unit clock

- **Do:** compare the head unit's time (iDrive clock, and the "checked at" time in the Store) with
  the phone's time, at ignition-on and again after ten minutes of driving.
- **Record:** the difference in minutes or days.
- **Why:** a clock so far off that the backend's certificate is not valid at that time (days off)
  breaks HTTPS; the car app then shows «Годинник головного блока неправильний» (on the pairing panel
  before pairing, in the answer area after it) instead of weakening certificate checks. A smaller
  error does not stop requests: every upload carries the car's clock time, and the backend moves
  reading times onto its own clock when the difference is more than two minutes.
- **Approval:** None.

### A5. Baseline load with iDrive Monitor

- **Do:** open iDrive Monitor with the engine running, idle; again with Android Auto connected;
  again while driving (read by a passenger).
- **Record:** CPU %, free memory, "apps memory x of y MB", swap.
- **Why:** the baseline against which our app's cost is measured, and the real shared memory cap
  (1000 or 1300 MB). Settles H-5.
- **Approval:** None.

### A6. Pop-up precedent

- **Do:** in iDrive Monitor press "Test pop-up" (parked). Then open navigation, and separately
  Android Auto, and trigger the test pop-up again if the app allows it from its settings, or watch
  for it during A5. Restart the head unit (normal ignition cycle) and, without opening iDrive
  Monitor, check that it is running (its pop-up or its live page when opened shows it was already
  sampling).
- **Record:** does the pop-up appear; does it appear over navigation and over Android Auto; does it
  close by itself; does the app run after a restart without being opened.
- **Why:** proves the autostart + BMW small pop-up path on this unit, which phase 4 relies on.
  Settles H-4 in part and H-10 in part.
- **Approval:** None.

### A7. Uplink over the phone hotspot

- **Do:** Store → Settings → Wi-Fi. Note the settings. Then switch the ignition off and on, and
  separately let the car sleep and wake it; each time wait without touching anything until the
  Store shows "Online".
- **Record:** whether Wi-Fi uplink is on, whether 5 GHz is allowed, the hotspot band on the phone;
  seconds from ignition-on to "Online"; whether the hotspot is rejoined after sleep.
- **Why:** the car is online only through the phone; the car app must work offline and resume on
  its own. Settles H-18 in part.
- **Approval:** None.

### A8. Uplink together with Android Auto audio

- **Do:** with Android Auto playing music (wireless if that is how it is used) and the uplink
  online, drive for 15 minutes (a passenger watches).
- **Record:** audio skips, HMI lag, uplink drops, and whether Android Auto stays connected.
- **Why:** community reports link the Wi-Fi uplink to audio skips with wireless phone projection.
  Settles H-18.
- **Approval:** None. (This is the owner's normal use; it changes nothing.)

### A9. Free space

- **Do:** check free space in the Store (Installed page or settings).
- **Record:** free space on the app storage.
- **Why:** `jap-node22` alone takes 137 MB; our app must stay within its 20 MiB data quota and the
  unit must keep headroom.
- **Approval:** None.

### A10. The Store's phone page (optional)

- **Do:** turn on the Store's phone access page, open it from the phone as the Store describes,
  then turn it off again.
- **Record:** whether it loads; what logs it shows; the firmware string it reports.
- **Why:** the only way to read some head-unit logs without SSH; useful later for diagnosing an
  install.
- **Approval:** None.

### A11. Read-only shell commands (only if a root key is available)

- **Do:** only if the service station or the owner holds root's key: from a laptop, run read-only
  commands the service station agrees to, for example the Store's read-only `status` report,
  `cat /usr/lib/oap-mainapp/package.json`, `df -h /var/opt`, and whether
  `/var/opt/jap-node22/current/bin/node` and `/var/opt/mgu-python/current/bin/python3` exist.
  Without a key, at most check whether port 22 answers (no login attempt).
- **Record:** the outputs, with any identifying values removed.
- **Why:** confirms MainApp version, free space and installed runtimes without guessing.
- **Approval:** Separate (a root shell on the car).

---

## B. With the Copilot app (phase 2)

These checks are done with Copilot itself (`p98_copilot`); there is no separate test app. It only
reads passive signals, never writes to the car and makes no diagnostic request.
`docs/CAR_INSTALL.md` describes how it is built and installed. Its log file holds, each line with
its time: the start line (app version, Node version, start reason), the `power:` lines, the
`self:` lines, pairing lines, `screen: … while asleep` lines, `uplink:` failure lines and other
warnings, and the kit's own info lines (`CAR_INSTALL.md` section 9). Reading the file needs
read-only shell access (A11); without it, only the screens and iDrive Monitor can be observed.
Where a check below asks for something this version does not log or show, it says so.

### B1. Store build path

- **Do:** add the private deploy repository as a Store source (branch channel, read-only token
  or "Sign in with GitHub"), install Copilot from it and open its tile (`docs/CAR_INSTALL.md`
  sections 1-4).
- **Record:** whether it lists, builds on the unit and shows a tile; build time; later, whether
  it uninstalls cleanly (`docs/CAR_INSTALL.md` section 13).
- **Why:** validates the private-repository and on-unit build path before real work.
- **Approval:** Install.

### B2. Runtime identity

- **Do:** read the start lines: the app's `Copilot <version> on Node <version>, start reason …`
  and the kit's `initialized (start reason …)`; if the SDK created no screens, the kit logs an
  error line saying so (`the SDK created no RHMI application …`).
- **Record:** the log lines. This version does not log `process.versions.openssl`,
  `process.execArgv`, `typeof global.gc` or `typeof WebAssembly`; those stay open.
- **Why:** the shared packages are built for Node 8.16.2; some units run 8.9.4; the start path
  decides how the pop-up is raised. Settles H-2, H-4.
- **Approval:** Install.

### B3. Autostart and long run

- **Do:** after a cold start (ignition on, tile never touched) leave the car on or drive for 60+
  minutes. Then install another app through the Store (this restarts the app manager) and check
  that the app comes back on its own.
- **Record:** start lines, absence of "shutdown requested by MainApp", the start type listed by
  the Store, the restart after the other install.
- **Why:** proves the background assistant can run without the screen. Settles H-3.
- **Approval:** Install.

### B4. Tile tap on the running app

- **Do:** while the autostart app runs without screens, tap its tile.
- **Record:** whether a new start line (new process) appears, whether the screen opens on the first
  tap.
- **Why:** if a tap starts a new process, state must be rebuilt from the small state file.
  Settles H-7.
- **Approval:** Install (same app).

### B5. Power states and shutdown

- **Do:** go through: unlock, ignition on, drive, ignition off, door open and close, lock, walk
  away; note the time of each step. Afterwards read the time-stamped `power:` lines (asleep, awake,
  driving) and the kit's `shutdown requested by MainApp`.
- **Record:** the `power:` transition at each step; minutes from locking to the last log line.
  This version collapses the car's condition values into those three states and does not log the
  raw values, nor which signals still arrive after ignition off.
- **Why:** the power gate stops all work when parked; the head unit's time awake after locking is
  undocumented. Settles H-8 in part.
- **Approval:** Install.

### B6. Which signals exist on this car

- **Do:** read the kit's start lines `this unit has no … - running without it` for interfaces the
  installer removed as missing on this unit, and look at the ДАТЧИКИ tab: a reading the car does
  not send shows «Недоступно» with its reason. Note the gear tile in P, R, N, D and in each gear.
- **If the Store refuses the install:** when the Store's build or install reports the 12 V charge
  field (`statusBattery2` of the CDS interface) or its interface as missing, publish again with the
  fallback `node car/scripts/publish-car.mjs --drop-reading battery12vCharge`, push and install again
  (`docs/CAR_INSTALL.md` section 10). The ДАТЧИКИ tab then shows the 12 V tile as «Недоступно».
- **Record:** present or missing for every tile; what the gear tile shows; whether the install
  needed the 12 V fallback. Not available in this version: the first raw value of each field, the
  raw gear values (`statusGearboxDrive`, `DataPowerTrain2`) and the engine type
  (`Vehicle2.statusVehiclePartType` is not declared in `app.json`, so it cannot be read).
- **Why:** no G01 signal catalogue is published; missing fields must show as unavailable, never as
  zero. Settles H-13 and part of H-1.
- **Approval:** Install.

### B7. Values against the cluster

- **Do:** parked and then on a steady drive, compare the app's values with the cluster and iDrive:
  engine speed, speed, oil and coolant temperature, fuel, range, odometer, tyre pressures and
  their targets (iDrive tyre pressure monitor), tyre temperatures if any, 12 V charge %, driving
  mode, service items (iDrive "Service requirements"); and the car's unit setting field.
- **Record:** each pair of values and units.
- **Why:** proves the scalings and units for this car before any value is shown or explained.
  Settles H-14.
- **Approval:** Install.

### B8. Notification rates

- **Do:** not available in this version: the app keeps no notification counts and logs nothing
  per signal. Skip it; at most note which ДАТЧИКИ tiles never get a value in B6.
- **Record:** nothing beyond B6.
- **Why:** decides which fields must be polled (no faster than every 10 s) and confirms the 1 Hz
  tick is enough. Settles H-13.
- **Approval:** Install.

### B9. The app's own resource figures

- **Do:** while the car is awake the app logs at most one self-measurement line every ten minutes,
  for example `self: rss=41MB heap=12MB cpu=0.6%` (`rss`: the process's memory now; `heap`: its
  JavaScript part; `cpu`: its share of one core since the previous line). Read these lines over a
  60-minute drive and 30 minutes idle with the screen closed, and once with its screen open, from
  its log file `p98_copilot.log` in its data folder (needs read-only shell access, A11) as
  `docs/CAR_INSTALL.md` section 9 explains; without that access, read the app's memory in iDrive
  Monitor. Compare with A5. After a few days, check the size of its data folder.
- **Record:** the `self:` figures and how `rss` changes from line to line; the renderer's log lines
  (`renderd: connected, screen …` means GPU frames; `display: no mgu-renderd socket - software
  rendering until it appears` or `display: software rendering (setting)` means software PNG
  frames); data folder size.
- **Why:** the budgets in `ARCHITECTURE.md` (≤ 60 MB steady RSS, zero growth, no flash history)
  are targets until measured. Settles H-6 in part.
- **Approval:** Install.

### B10. Check Control

- **Do:** parked, engine off, ignition on, trigger a harmless Check Control message: for example
  open the bonnet, or unbuckle the driver's seat belt while stationary. Close it again.
- **Record:** what the СПОВІЩЕННЯ tab and the pop-up show (severity word and icon, title, tag
  line), the language of the text, the delay compared with the cluster, whether the app received
  it with its screen closed (the pop-up appears, or the entry is on the tab when you open it), and
  whether it is marked «ЗНЯТО …» after you close the bonnet or buckle up. Not logged or shown by
  this version: the raw structure of `basicList` and `ccList`/`newCCMessage`, the active-state
  values and the colour values.
- **Why:** Check Control is the only BMW-authoritative warning source and the main alert trigger;
  its colours and text language are undocumented. Settles H-15.
- **Approval:** Install.

### B11. Our pop-up in the car

- **Do:** in the app's settings («Налаштування») turn the switch «Тестове сповіщення» on (if it is
  already on, off and on again: only switching it on shows the pop-up). About four seconds later the
  app shows one pop-up «Тестове сповіщення Copilot» through the same path as an alert (it needs
  «Спливаючі сповіщення» on, and the phone's switch «Вікна на екрані авто» on, and it waits while
  reversing); it is not listed, stored or sent to the phone. Use the four seconds to bring navigation to the front, and repeat with Android Auto in
  front. Then repeat B10 and watch that BMW's own Check Control message appears first and is never
  covered by ours: the kit exposes no pop-up priority, so this can only be seen on the car.
- **If the pop-up shows blank or wrong text** (empty boxes, gaps, missing Ukrainian letters): turn on
  «Сповіщення латиницею» and trigger the test pop-up again; it should read «Testove spovishchennia
  Copilot».
- **Record:** whether it shows, how long, whether BMW's messages take precedence, whether
  Ukrainian letters `і ї є ґ` display in the pop-up or the Latin text switch is needed.
- **Why:** phase 4's exit depends on this; BMW's warnings must never be hidden or delayed.
  Settles H-10, H-11.
- **Approval:** Install.

### B12. Ukrainian text on the drawn screen

- **Do:** open the app's three tabs and its settings, whose three rows are Ukrainian
  («Спливаючі сповіщення», «Сповіщення латиницею», «Тестове сповіщення»). There is no pangram
  screen: the app's fixed texts show `і І є Є` (`ї` only in the note shown when the backend address
  is missing). To check `ґ Ґ ї Ї`, keep the car's screen open on the ПОМІЧНИК tab (paired, car
  awake) and type a short question containing them on the phone panel (the car cuts the question to
  one line): the car shows that question and its answer. An alert text the car sends may contain
  them too. The screen draws every typographic apostrophe (`’`, `ʼ`) as `'`. The tile title is
  «Copilot» (Latin letters).
- **Record:** which characters render, on the drawn screen and in BMW's own text (settings rows);
  a character the screen's font lacks is drawn as `□`.
- **Why:** the shipped atlas lacks these letters; the car app ships a re-baked one. Settles H-11.
- **Approval:** Install.

### B13. Touch on the drawn screen

- **Do:** on the app's screen tap each header tab (ПОМІЧНИК, ДАТЧИКИ, СПОВІЩЕННЯ) and, parked and
  after pairing (`docs/CAR_INSTALL.md` section 5; until then the pairing panel replaces the chips),
  one question chip on the ПОМІЧНИК tab (and, for comparison, a drawn button in an app already
  installed). The screen is operated by touch: the kit no longer takes over the iDrive controller,
  so the controller may not move between the tabs and chips.
- **Record:** whether each tap reaches the app (the tab changes; after a chip, the answer area shows
  «Готую відповідь…»).
- **Why:** the tabs and the topic chips on the iDrive screen need the Store renderer's touch routing.
  Settles H-12.
- **Approval:** Install.

### B14. One request to the backend over the uplink

- **Do:** with the uplink online and the backend running with `VEHICLE_SOURCE=car`, pair the app
  (`docs/CAR_INSTALL.md` section 5), then tap a question chip, parked and (by a passenger) while
  driving.
- **Record:** the МЕРЕЖА mark; the answer, or the error line in the answer area («Немає зв'язку з
  сервером», «Годинник головного блока неправильний», «Сервер відхилив запит»); and, with log
  access, the `uplink: <kind> (<path>)` line for the first failure of each kind (offline, dns,
  timeout, tls, server-error, client-error) and the wrong-clock line. Not measured by this version:
  latency and request and response sizes; whether the lease file appears only while online needs
  shell access (A11).
- **Why:** the car → backend path is the only cloud path; certificate checks are not weakened.
  Settles H-19.
- **Approval:** Install.

### B15. Nothing left running when parked

- **Do:** after leaving the app's screen, and after ignition off and locking, check the log and
  iDrive Monitor. Then a second pass with the app's screen left open at ignition off and at
  locking.
- **Record:** that no request, `uplink:` line or other line of the app follows `power: … ->
  asleep`; in the second pass, whether `screen: hidden while asleep` follows and how long after
  the switch to parked (no such line, with no `shutdown requested by MainApp` and no
  `power: asleep -> …` after it, means the head unit kept reporting the screen as shown).
- **Why:** the app must not keep the uplink or the head unit awake. Its own timers and requests
  stop when it sleeps, but the kit's screen loop (up to four turns a second) and, with the GPU
  renderer, its keep-alive follow the screen's visibility, not the app's power state; the second
  pass shows how long that lasts on this car.
- **Approval:** Install.

### B16. Overnight shutdown and 12 V

- **Do:** two comparable nights: one without the app, one with it installed. Lock the car normally.
  Measure the 12 V battery voltage in the evening and the morning with a meter (or the car's own
  battery display if it has one), and note when the head unit stops (for example the Tailscale
  tool showing the car offline, or the app's last log line).
- **Record:** both voltages, both shutdown times, temperature.
- **Why:** an anti-goal is draining the battery or keeping the car awake. The app stays registered
  as active with BMW's app manager for its whole life, parked included (`docs/CAR_INSTALL.md`,
  «What you should know before installing»); this measures whether that or anything else changes
  when the unit sleeps. Settles H-8.
- **Approval:** Install.

### B17. Writable locations (optional)

- **Do:** not implemented in this version: the app writes its state, log and settings in its own
  data folder, and the kit writes the screen's PNG frames (four rotating files, removed at the next
  start) in the app's own `rhmiData/resources` folder; it checks no other location. Skip it unless a
  later version adds the check.
- **Record:** nothing.
- **Why:** a RAM-backed location could hold debug logs without flash wear.
- **Approval:** Install.

### B18. Platform proxies in the package manifest (open question)

- **Do:** nothing beyond B5 and B16; read their results with this question in mind. The kit's build
  (`car/kit/tools/build.py`, `PLATFORM_PROXIES`, lines 38-71) declares, in every app's SOME/IP
  manifest, the platform interfaces BMW's own apps declare. Besides the HMI and resource
  interfaces they include the wake-on-demand interfaces (`WakeUpOnDemand`, `WodControl`), the
  node-state consumer with `RegisterShutdownClient`, other methods that change platform state
  (`PrivacySettings` setters, `Provisioning.setFilterForProvisioningData`, `PrivateEntryPoint` and
  `AppBookmarks` registration), the BMW account's identity attributes (`UserAccount` name and
  `gcid`) and `Lifecycle.powerStateDetailed`; the constant is the full list. Our code and the kit's
  runtime never call any of them (the runtime uses BMW's SDK only through `OnlineApp` and the
  SDK's logger; a test checks the wake and shutdown names in our code and the bundle), and the list
  is left as the kit ships it. Whether BMW's SDK itself calls any of them inside the app's process
  is not known.
- **Record:** whether, with the app installed, the head unit stays awake longer after locking or
  wakes on its own (B5, B16), and anything the Store or the service station can say about what
  these declarations allow and whether an app starts without them.
- **Why:** what declaring them allows, whether BMW's SDK uses them, and whether they can be
  removed without breaking the app's start are not known; they are not assumed to be harmless.
  Settles H-27.
- **Approval:** Install (same app).

---

## C. Only after separate explicit approval

Each check here touches diagnostics or audio. Each needs the owner's separate, explicit approval
for that check, given after reading it. Diagnostic reads are done parked, ignition on, engine off,
with a battery charger connected if possible, one at a time, and are never repeated in a loop.

### C1. Identify the engine and gearbox control units

- **Do:** one read-only request `22 F150` to the engine unit and to the gearbox unit.
- **Record:** the identifiers returned; any refusal code.
- **Why:** confirms the engine family (B46/B48 expected) and gearbox for the catalogue's
  diagnostic candidates. Settles H-1, H-16 in part.
- **Approval:** Separate (diagnostics).

### C2. One fault-memory read

- **Do:** one functional read `19 02 0C` to all units.
- **Record:** duration (expect up to about 25 s), number of units answering, faults found with
  their status bytes, and that no new warning or Check Control message appears afterwards; whether
  the head unit or cluster stays awake longer than usual afterwards.
- **Why:** the only path to fault codes; it keeps the car awake while it runs. The design keeps
  diagnostics disabled until this is approved and observed.
- **Approval:** Separate (diagnostics).

### C3. Engine-unit identifiers

- **Do:** one read each of the candidate identifiers for intake air temperature (`F40F`, `580F`),
  boost (`580B`, `4AB0`, `F470`), load (`5813`, OBD PID `04`), module voltage (`F442`, OBD PID
  `42`) and oil (`4402`, OBD PID `5C`; service `4404`, `411A`).
- **Record:** which answer and which are refused (code 31); time per read; any "busy" refusals.
- **Why:** the candidate tables were made for other engines; only identifiers this car answers
  may ever be offered. Settles H-16.
- **Approval:** Separate (diagnostics).

### C4. M-Copilot as a probe (optional)

- **Do:** install M-Copilot unchanged from its Store source, pair a key from a separate Console
  workspace with a low spend limit, ask non-fault questions parked and on a drive, open its "Data
  check" page; then uninstall it and revoke the key.
- **Record:** which signals its data page shows; answer latency over the hotspot; its log lines
  about the uplink and frame cost.
- **Why:** a zero-code look at the car's signals and uplink latency. It can make diagnostic reads
  (fault memory for fault questions, engine reads under load) through an unrestricted link and
  stores an API key on the head unit, which is why it needs separate approval.
- **Approval:** Separate (diagnostics) and Install.

### C5. Steering-wheel voice button, observed only

- **Do:** with a listen-only app (subscribing to
  `de.bmw.infotainment.controlelements.SteeringWheelPushButton` field `statusPTTButton1`), press
  the voice button short and long, with Android Auto connected and without it.
- **Record:** raw values; whether the app receives them with its screen closed; which assistant
  starts (BMW's or Google's).
- **Why:** the button cannot be taken over (BMW's assistant always reacts); this only records
  whether it could ever be an additional trigger.
- **Approval:** Separate (voice and audio).

### C6. BMW's assistant and Ukrainian

- **Do:** iDrive → Settings → General settings → Language: note whether Ukrainian is offered; if
  it is, set it, press the voice button, then restore the previous language.
- **Record:** whether Ukrainian is offered, and what BMW's assistant does.
- **Why:** information only; the design does not use BMW's speech engine.
- **Approval:** Separate (voice and audio).

### C7. Phone voice through the car

- **Do:** with the companion's talk screen (`docs/VOICE_CAR_TEST.md`, Plan 3), parked: record a
  question and play an answer over Android Auto, then over plain Bluetooth.
- **Record:** whether the iDrive shows a call or hands-free screen; whether the car's or the
  phone's microphone is used (cover the phone's microphone to tell); playback quality; how long
  until music returns to normal quality.
- **Why:** voice depends on the phone's audio routing in this car. Settles H-26.
- **Approval:** Separate (voice and audio).

### C8. Ukrainian recognition and voices on the phone

- **Do:** in Chrome on the phone, test `uk-UA` recognition with 20 car phrases (numbers, units,
  «тиск у шинах», fault codes) parked, and while driving with a passenger operating the phone;
  list the phone's `speechSynthesis` voices.
- **Record:** recognition errors; whether a Ukrainian voice exists and how it sounds.
- **Why:** the free browser path is the default; cloud speech is added only if this is not good
  enough. Settles H-25.
- **Approval:** Separate (voice and audio).

### C9. BMW warning sounds versus phone audio

- **Do:** parked, while the phone plays a spoken answer through the car, provoke a harmless BMW
  sound: open a door with the ignition on, or select reverse with the parking sensors active.
- **Record:** whether BMW's sound is still heard clearly and on time, and whether the phone's
  audio is lowered or overlaps it.
- **Why:** BMW warnings must never be masked. If BMW's sound is not clearly audible, stop and
  report it; spoken answers must then stay off while such warnings are active.
- **Approval:** Separate (voice and audio).

### C10. Steering-wheel media key and end-to-end latency

- **Do:** with the companion playing audio, press the steering-wheel "next" key and see whether
  the page receives it; measure ten times the time from releasing the talk button to the first
  spoken word (parked, phone on mobile data).
- **Record:** whether the key reaches the page; the ten latencies.
- **Why:** a possible hands-free trigger, and the figure behind open decision 3 (model for the
  spoken route).
- **Approval:** Separate (voice and audio).

### C11. Head-unit audio interfaces (research only)

- **Do:** only if a read-only way to view the unit's interface catalogue exists (for example
  through the service station): list interface names containing speech, tts, prompt, readout,
  dialog, microphone or voice, and the instances of BMW's media player interface.
- **Record:** the list.
- **Why:** information only; head-unit sound stays excluded by the read-only rule.
- **Approval:** Separate (audio).

### C12. Sound from the head unit itself — not planned

The research describes a way to play a file through BMW's media player. It needs state-changing
calls into BMW's audio manager, displaces the driver's audio source, and has an unknown effect on
BMW's warning sounds. It is excluded by the design (spec §2). It is listed here only so that it is
not mistaken for a forgotten check: **do not run it** unless the owner explicitly reverses that
decision, in which case it gets its own written procedure first.

---

## Where each check comes from

| Check | Spec §12 | Research reports |
|---|---|---|
| A1 | 1 | store, issues, lifecycle, mcopilot, ui |
| A2 | 2 | store, issues |
| A3 | 6 | issues, ui, audio |
| A4 | 5 | store, claudeapi, issues |
| A5 | 3 | footprint, issues |
| A6 | 3 | store, lifecycle |
| A7 | 4 | store, issues |
| A8 | 4 | store, audio, voice, issues |
| A9 | — | store, issues |
| A10 | — | store |
| A11 | — | store, lifecycle |
| B1 | — | store |
| B2 | 7 | lifecycle, footprint, ui, claudeapi, mcopilot |
| B3 | 9 | lifecycle, telemetry, footprint |
| B4 | 9 | lifecycle |
| B5 | 9 | lifecycle, footprint |
| B6 | 8 | telemetry, mcopilot |
| B7 | 8 | telemetry, mcopilot |
| B8 | 8 | telemetry, footprint |
| B9 | 7 | footprint, ui, claudeapi, mcopilot |
| B10 | 10 | telemetry |
| B11 | 11 | ui, audio, mcopilot |
| B12 | 11 | ui, mcopilot, voice |
| B13 | — | ui |
| B14 | 12 | claudeapi, footprint |
| B15 | — | claudeapi, ui, mcopilot |
| B16 | 13 | footprint, telemetry, issues, mcopilot |
| B17 | — | lifecycle |
| B18 | — | lifecycle |
| C1 | — | telemetry |
| C2 | 14 | telemetry, footprint, mcopilot |
| C3 | — | telemetry, footprint |
| C4 | (§3 optional probe) | mcopilot |
| C5 | — | audio, ui, voice |
| C6 | — | audio |
| C7 | — | voice, audio |
| C8 | — | voice |
| C9 | — | voice, audio |
| C10 | — | voice, claudeapi |
| C11 | — | audio |
| C12 | — | audio |

Report checks not carried over: the iPhone-specific voice checks and the Claude iOS app in CarPlay
(the owner uses Android with Android Auto); placing a home-screen widget (the design does not use
one); the head-up display output (excluded); counting tokens of the real prompt and confirming the
plan's API credits (done off the car, not car checks).
