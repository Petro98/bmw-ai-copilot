# Installing the car app (owner's guide)

This guide is for the owner. **Nothing in this project installs anything on the car by itself**: every step
below is done by you, by hand, and every install through the MGU Store asks for your confirmation. Read the
ground rules at the top of [`CAR_CHECKLIST.md`](CAR_CHECKLIST.md) first; they apply to everything here (parked
and safe unless a step says otherwise, stop at the first unexpected warning, never write a vehicle
identification number, key, token or address into notes that go into a repository).

The app is called **Copilot** on the head unit (Store id `p98_copilot`). Its code is `car/src/`, bundled into
`car/apps/p98_copilot/main.js`, and the Store builds it on the head unit with the vendored kit in `car/kit/`.

## What the app does and never does

It does:

- start with the head unit (autostart) and keep running in the background while the car is awake;
- read the car's passive signals (engine speed, speed, oil and coolant temperature, 12 V charge level, fuel,
  range, odometer, tyre pressures and their targets, gear, driving mode, vehicle condition, Check Control and
  service messages), the same way other Store apps read them;
- run the shared alert rules and show BMW's small pop-up for a `critical` or `warning` alert (Check Control,
  service, and the limits you set yourself on the phone), a few seconds after the car's own message;
- show a Ukrainian screen with three tabs (ПОМІЧНИК, ДАТЧИКИ, СПОВІЩЕННЯ) while you have it open;
- send your backend, over the Store's internet uplink: a small snapshot at most once a minute while driving,
  each `critical` or `warning` alert as soon as it is raised, its clearing (or its return) with the next of those
  sends, or on its own within a minute when none comes, and the questions you tap on the screen. A question
  tapped while the car is not driving carries the current readings (sent as one snapshot just before it). While the screen is open it also keeps one request
  waiting for answers you asked on the phone, and ends that request as soon as you leave the screen. Each time
  the car wakes and is online it fetches your limits and the phone's pop-up switch once; while the pairing panel
  is shown it tries the backend again every 30 seconds. A failed request is not repeated at once: the waiting
  request tries again after 5 seconds and the settings fetch after a minute, each wait doubling with every
  further failure up to ten minutes, and starting over when the car wakes or the backend answers;
- keep one small state file in its own data folder (alert memory, your limits, the pairing id and secret, and up
  to 20 alert events the backend has not received yet, sent again on the next start; an event already received
  may be sent once more, and the backend ignores the repeat). It is written when something in it changed: when
  the car goes to sleep, when pairing or your settings change, at once when a `critical` or `warning` alert is
  raised, and for clearings at most once a minute.

It never:

- writes to the car, calls a vehicle function, or sends a diagnostic request (the diagnostic gate ships
  disabled and has no caller; no signal is declared writable);
- runs its own work while the car is parked or locked: none of its own timers, no request, no pop-up, no
  connection; it only listens for the car's condition to change. One exception is not the app's: while the head
  unit still reports the app's screen as shown, the kit that draws it keeps checking the screen up to four times
  a second (and, with the GPU renderer, re-sends the last picture once a second) until the screen is reported
  hidden; car check B15 records how long that lasts on this car;
- holds an API key: Claude is called by your backend, never by the car;
- updates itself: a new version is installed only when you tap Update in the Store.

## Before you start

You need:

1. The MGU Store on the head unit with the GPU renderer (`mgu-render`, 0.6.11 or later; `mgu-repo.json`
   requires it), the Store's Python tool `mgu-python` (the Store runs the app's build, `car/kit/tools/build.py`,
   with it; it comes with the Store's updater), and the Store's internet uplink working over your phone's hotspot
   (the Store shows "Online"). Car checks A1 and A7 in [`CAR_CHECKLIST.md`](CAR_CHECKLIST.md) record this.
2. The head unit's clock close to the real time (check A4). With a clock so far off that your backend's
   certificate is not valid at that time (days off), every request fails and the screen says «Годинник головного
   блока неправильний»: on the pairing panel in place of its instructions (the QR code stays), and after pairing in
   the answer area of the ПОМІЧНИК tab, without a tap. The app does not weaken certificate checks to work around
   it. A smaller error is harmless: every upload carries the car's clock time, and the backend moves the reading
   times onto its own clock when the car's clock is off by more than two minutes.
3. Your backend running and reachable from the internet at an `https://` address with a valid certificate, with
   `VEHICLE_SOURCE=car`, `OWNER_TOKEN` and `SESSION_SECRET` set (README, «Owner access, device pairing and the car
   source»), so that only you can open the phone panel and register devices. With the default demo source the
   backend refuses the car's readings, alerts and questions: the car's network mark turns to «НЕМАЄ МЕРЕЖІ», and a
   question tapped on the car's screen ends with «Сервер відхилив запит».
   If the backend's database ran the demo before, the first start with `VEHICLE_SOURCE=car` deletes the demo
   alert events, telemetry and engine state by itself. Paired devices, settings, spend and the dialog are kept,
   but earlier dialog turns are no longer given to Claude as history. A later demo start on this database is
   refused unless `ALLOW_VEHICLE_SOURCE_RESET=1` is set for that start; to run the demo next to real data, give it
   its own `DATABASE_PATH` (README, «Demo data and the car's data in one database»).
4. A GitHub account with two-factor authentication, for one **private** repository (the Store's source).
5. A computer with this repository checked out and Node 22 (`npm ci` once). The publish script needs nothing
   else; it only copies files.

## 1. Create the private deploy repository

The Store builds the app from a git repository. That repository will contain your backend address, so it must
be **private** and must not be this (public) repository.

1. On GitHub, create a new **private** repository, for example `copilot-car`, with no template.
2. Clone it next to this repository, for example to `~/copilot-car`.
3. In it, create a `.gitignore` with these two lines, so that a local build or BMW's SDK is never committed:

   ```
   car/dist/
   car/oap-sdk/
   ```

Never make this repository public and never fork it into a public one.

## 2. Run the publish script

1. In this repository, copy `.env.car.example` to `.env.car` (git-ignored) and fill in:
   - `CAR_DEPLOY_DIR`: the absolute path of the checkout from step 1;
   - `CAR_BACKEND_URL`: your backend's `https://` address, exactly as your phone opens it, without a trailing
     slash. The example value `https://example.invalid` is refused on purpose.
2. Run:

   ```
   node car/scripts/publish-car.mjs
   ```

   It copies `mgu-repo.json`, `car/kit/` and `car/apps/` into the deploy checkout, writes the backend address into
   the copied `car/apps/p98_copilot/app.json` (`"config"` → `"backendUrl"`) and nowhere else, prints how many
   files were added, changed and removed, and stops. It does not print the address, runs no git command and no
   network command, and refuses to write into this repository or into a directory that is neither a git
   checkout, nor empty, nor an earlier publish.
3. Review the change in the deploy checkout (`git status`, `git diff`), then commit and push it yourself.

In this repository `car/apps/p98_copilot/app.json` keeps `"backendUrl": null` on purpose. If the car screen ever
says «Адресу сервера не налаштовано», the Store built the app from a copy without the address: run the script
again and push.

## 3. Add the repository to the MGU Store

On the head unit, parked:

1. Give the Store read access to the private repository, in the Store's settings under accounts, in one of the
   two ways the Store offers: "Sign in with GitHub" (then install the Store's GitHub App on **this repository
   only**), or a fine-grained personal access token limited to this repository with "Contents: Read-only".
2. Add the repository (`<your account>/copilot-car`) as a source on the **branch** channel. Every pushed
   commit then shows up in the Store as a new revision.

Menu names can differ between Store versions; car check B1 records how it looks on this unit.

## 4. Install the app

1. In the Store, open **Copilot** from your source and tap Install. Confirm the install. The Store builds the app
   on the head unit; this takes a while (B1 records how long).
2. The app starts by itself. Its tile is in the apps menu; open it once to see the screen.
3. If the Store refuses the install because this unit's firmware lacks a field the app declares, see
   [section 10](#10-if-the-store-refuses-the-install-the-12-v-field).

## 5. Pair the car with your phone

Until your backend has accepted this car, the ПОМІЧНИК tab shows the panel «ПІДКЛЮЧЕННЯ ДО ТЕЛЕФОНА» with a QR
code instead of the question chips.

1. Make sure the car is online (the Store shows "Online") and keep the app's screen open.
2. Scan the QR code with the phone's camera. It opens your backend's `/pair` page; log in with your owner token
   if the page asks.
3. The car's screen shows no device id to compare, so confirm only if you have just scanned the QR code on the
   screen of your own car: give the car a name and tap «Підʼєднати».
4. Within about a minute (the car tries again every 30 seconds while the panel is shown, and the backend may hold
   that request up to 25 seconds before it answers) the panel gives way to the assistant and the network mark
   turns on. The car remembers that it is paired.
5. Check that the backend runs with the car as its source: tap a question chip on the car (it sends the current
   readings with the question), or start the engine (the car then uploads once a minute). On the phone, «Авто»
   then shows this car's values, and no «ДЕМО-ДАНІ» strip is shown. Until then «Авто» shows «Дані ще не
   отримано.»: with only the ignition on, the car sends no readings by itself.

While the pairing panel is on screen the app does not rest (section 6), so a quiet car being paired stays
awake; it rests only when the car reports parked or standby, or after 15 quiet minutes once the screen is hidden.

The QR code carries the car's device secret. Do not photograph the pairing panel or share a picture of it. If
the device is ever revoked on the phone (Settings, devices), the car shows the pairing panel again on its next
request. Revoking a device also clears, on the phone, every active alert the car had reported; the car reports
its standing alerts again on its next start.

## 6. The three status marks

The top right of the screen shows three words. Each is a word, not only a colour: lit (blue) when it works, grey
with «НЕМАЄ …» when it does not.

| Mark | Lit means | «НЕМАЄ …» means |
|---|---|---|
| АВТО | the app is awake and holds at least one reading from the car. It does not mean the values are new: most readings count until the car has reported no change of any signal for five minutes (a reading the car stops updating while other signals still arrive keeps its last value), polled ones (fuel, range, tyres) for five minutes after their last poll, and the odometer, service items and Check Control messages until the app sleeps | the app is asleep, or it has no reading from the car (just woken up, or nothing has arrived) |
| МЕРЕЖА | this car is paired and your backend has answered a request from it since the car last woke up | not paired yet, no internet (hotspot or uplink), the backend does not answer or refused the car, the head unit's clock is wrong, or no request has been answered yet since waking |
| CLAUDE | МЕРЕЖА is lit and the last question asked from the car did not fail | the network is down, or the last question failed (the reason is in the answer area) |

The CLAUDE mark does not test Claude on its own: it only says that nothing failed on the way. Error lines in the
answer area are «Немає зв'язку з сервером» (no internet, the name or the secure connection could not be set up,
or no answer in time), «Годинник головного блока неправильний» (the clock; it also shows without a tap, and stays
until the backend answers a request) and «Сервер відхилив запит» (the backend refused the question or failed:
for example the monthly budget is used up, the backend runs with the demo source, it answered with a server
error, or it dropped the connection).

With the engine off, after a long network fault the МЕРЕЖА mark can take up to ten minutes to come back on its
own (failed requests back off, see «What the app does and never does»); asking a question brings it back at once.

**When the app rests.** With the engine off and no signal from the car for 15 minutes, the app goes to sleep as if
the car were parked: no tick, no requests, its readings blank. Asking a question or opening its screen wakes it
again (while the pairing panel is on screen the 15 minutes never run out, so it does not rest this way), and so
does the car reporting its condition again (for example when you press Start). A car that reports parked or
standby stays asleep.

## 7. Settings

On the car (the app's own settings, «Налаштування»):

- **«Спливаючі сповіщення»** (pop-ups, on by default): off means alerts are only listed on the СПОВІЩЕННЯ tab and
  sent to the phone, never shown as a pop-up.
- **«Сповіщення латиницею»** (Latin pop-up text, off by default): the pop-up text is written in Latin letters
  (Ukrainian transliteration), for example «Avto povidomliaie: Tysk u shynakh». Turn it on if the pop-up shows
  empty boxes, gaps or nothing where Ukrainian letters should be. BMW's pop-up widget may not draw Cyrillic on
  this unit, and **the app cannot detect that**: only you can see it (car check B11). The app's own screen is not
  affected; it has its own Ukrainian font.

- **«Тестове сповіщення»** (test pop-up, off by default): switching it on shows one pop-up «Тестове сповіщення
  Copilot» about four seconds later, through the same path as an alert: it needs «Спливаючі сповіщення» on (and
  the phone's switch below), waits while reversing, and follows «Сповіщення латиницею». It is not listed, stored
  or sent to the phone. The app cannot switch it back off by itself, so it stays on: to see the pop-up again,
  switch it off and on. It does nothing while the car is parked and asleep. Car check B11 uses it.

On the phone panel, the switch «Вікна на екрані авто» must be on as well: a pop-up appears only when both
switches are on. The car fetches the phone's switch and your limits when it wakes up and is online, so a change
on the phone reaches the car on its next drive.

## 8. What to watch on the first drives

A passenger watches; the driver does not operate the phone or the screen for these.

- **BMW's own messages must win.** Our pop-up waits a few seconds after a Check Control message so that BMW's
  message comes first, and it never shows while reversing. The kit exposes **no pop-up priority**, so whether
  BMW's warnings are always drawn over ours is not known yet (B11; the switch «Тестове сповіщення» in section 7
  shows our pop-up on demand, parked). If our pop-up ever covers or delays a BMW message, stop and uninstall.
- **The screen is operated by touch.** The kit no longer takes over the iDrive controller (by design: no
  controller grab), so the controller may not move between the header tabs and the chips. Tabs and chips need
  the renderer's touch routing (B13). If tapping does nothing, note it; the app keeps working in the background.
- **Long answers are cut on the car screen.** Standing, an answer shows up to eight lines; moving, up to three
  in the short spoken style. The full answer is always on the phone.
- **Questions asked on the phone with the engine off** are answered from the car's last upload (from the last drive,
  or from the last question tapped on the car), with their age; a question tapped on the car's screen carries the current readings.
- Values against the cluster (B7), Check Control (B10), Ukrainian letters on the screen and in the pop-up (B11,
  B12), and that nothing keeps running after locking (B15, B16).

## 9. Reading the self-measurement

While the car is awake the app writes, at most once every ten minutes, a line like:

```
self: rss=41MB heap=12MB cpu=0.6%
```

- `rss`: memory the app's process uses now. The target is 60 MB or less, steady over a drive (the declared cap
  is 128 MiB). Lines that keep growing from one to the next over a long drive are a leak: note them.
- `heap`: the JavaScript part of that memory.
- `cpu`: the app's share of one processor core over the last ten minutes. It should stay low (the declared limit
  is 30).

The line goes into the app's log file `p98_copilot.log` in its data folder on the head unit (the kit keeps it
under 256 KB, with one older copy `p98_copilot.log.1`) and into the head unit's system log. Other lines in the
same file, each stamped with the time: one at start (app version, Node version, start reason), one on each power
change (for example `power: awake -> driving`, `power: driving -> asleep`), pairing lines (`pairing: the backend
accepted this car`), `screen: shown while asleep` / `screen: hidden while asleep` when the head unit shows or hides
the app's screen while the app sleeps, the first failure of each kind per waking period as `uplink: <kind>
(<path>)` (and one line for the wrong clock), and errors, at most once a minute each. The kit adds its own lines:
`starting …`, `initialized (start reason …)`, `registered active (…)`, `shutdown requested by MainApp`, `this unit
has no … - running without it` for an interface the installer left out, and the renderer's `renderd: connected,
screen …` or `display: no mgu-renderd socket - software rendering until it appears`. The Store's phone
page does not show an app's own log, so reading the file needs read-only shell access (car check A11, separate
approval, or the service station). Without it, compare the app's memory in iDrive Monitor with the baseline of
check A5 (check B9).

## 10. If the Store refuses the install: the 12 V field

The app declares the 12 V battery charge field (`statusBattery2` of the CDS interface) as required, together with
engine speed and temperatures. Some firmware may lack it, and the installer may then refuse the whole app. If
the Store's build or install reports that field (or that interface) as missing:

1. Run the publish script again with the fallback option:

   ```
   node car/scripts/publish-car.mjs --drop-reading battery12vCharge
   ```

   It leaves that one field out of the deployed `app.json` and tells the app that the reading is missing.
2. Commit, push, and install (or update) again.

The ДАТЧИКИ tab then shows the 12 V tile as «Недоступно» with «На цьому авто цього показника немає.»; nothing else
changes. Running the script again without the option puts the field back.

## 11. Updating the app

When this repository has a new version: run `node car/scripts/publish-car.mjs` again (with the same options as
before), review, commit and push in the deploy checkout, then tap Update in the Store and confirm. Nothing
updates by itself.

## 12. Before a BMW software update

A BMW software update removes the Store's setup from the head unit; installed apps stay listed but no longer
start, and re-installing needs root access (see A2 in the checklist). The Store's author advises uninstalling
before an update. Uninstall Copilot first (below), and agree the procedure with the service station that
installed the Store, with a battery charger connected.

## 13. Uninstalling

1. In the Store, open the installed apps, choose **Copilot** and remove it. Confirm. Nothing else of the car or
   the Store changes.
2. On the phone panel, revoke the car's device (Settings, devices), so its secret no longer works anywhere.
3. If you will not install it again: remove the source in the Store, and remove the Store's access to the
   repository on GitHub (the GitHub App, or delete the token).

## Stop and uninstall if

- any BMW warning, Check Control message or behaviour of the car appears that you did not expect;
- our pop-up covers, hides or delays one of BMW's own messages;
- the head unit becomes slow, restarts, or iDrive Monitor shows the app's memory climbing over a drive;
- the head unit no longer goes to sleep after locking, or the 12 V battery is weaker in the morning (B16);
- the app shows a value that clearly contradicts the cluster (B7).

## What you should know before installing

- **Platform proxies in the package manifest.** The kit's build (`car/kit/tools/build.py`, `PLATFORM_PROXIES`,
  lines 38-71, copied into every app's SOME/IP `manifest.json` by `manifest_for`) declares the platform
  interfaces BMW's own apps declare. Besides the HMI and resource interfaces they include the wake-on-demand
  interfaces (`WakeUpOnDemand` with `registerParticipant`, `WodControl` with `offerService`), the node-state
  consumer with `RegisterShutdownClient`, other methods that change platform state (`PrivacySettings` setters,
  `Provisioning.setFilterForProvisioningData`, `PrivateEntryPoint` and `AppBookmarks` registration), the BMW
  account's identity attributes (`UserAccount` name and `gcid`) and `Lifecycle.powerStateDetailed`; the constant is
  the full list. Our code never calls any of them (a test checks the wake and shutdown names in our code and the
  bundle), and neither does the kit's runtime: it uses BMW's SDK only through `OnlineApp` and the SDK's logger
  (start, initialized, the app's active/inactive status, screen visibility, its events and the RHMI application it
  creates). Whether BMW's SDK itself calls any of them inside the app's process is not known (the SDK is not in
  this repository). So what declaring them allows, and
  whether they can be removed without breaking the app's start, are **open questions** for the car checks (B18,
  read with B5 and B16), not something this guide can call harmless.
- **The app stays registered as active.** It asks the kit to keep it running while hidden
  (`ctx.background('monitor', true)`, as iDrive Monitor does), so it reports itself ACTIVE to BMW's app manager for
  its whole life, parked included. Whether that changes when the head unit sleeps is what B16 measures.
- **The pop-up has no priority setting** (section 8).
- **The diagnostic gate is disabled.** The ДАТЧИКИ tab shows the intake temperature as needing a diagnostic
  read, which is switched off. Nothing in this version can turn it on.
- **The backend address lives only in your private deploy repository.** Anyone who can read that repository can
  find your backend; the backend still refuses every car request without a registered device secret.

## The car checks

The on-car checks are in [`CAR_CHECKLIST.md`](CAR_CHECKLIST.md); this guide does not repeat them. The first-pass
checks of the spec (§12, items 7-13) map to it as follows:

| Spec §12 | Checklist | What to look at |
|---|---|---|
| 7. Node version, memory and CPU | B2, B9 | the start line; the `self:` lines (section 9) |
| 8. Which signals exist, rates, values | B6, B7, B8 | the ДАТЧИКИ tab against the cluster |
| 9. Autostart, long run, tile tap, shutdown | B3, B4, B5 | the start lines and `power:` lines |
| 10. Check Control | B10 | the СПОВІЩЕННЯ tab and the pop-up |
| 11. Ukrainian glyphs | B11, B12 | the screen and the pop-up (section 7) |
| 12. One request to the backend | B14 | the МЕРЕЖА mark after pairing; `uplink:` lines |
| 13. Overnight shutdown and 12 V | B16 (related: B15) | the evening and morning voltage; no log line of the app after locking (B15) |

This version does not expose the raw-value parts of items 7, 8, 10 and 12: `typeof global.gc` and the other
runtime details, notification rates, the raw Check Control structure and colour values, and request latency
and sizes are not logged. The checklist marks those parts as not available.
