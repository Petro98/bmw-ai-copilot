# Voice in the car: the owner's test drive checklist

The first drives with voice. Everything here happens on the owner's Android phone: the panel
(«Copilot») is a web app installed to the phone's home screen. Nothing is installed on, sent to or
run against the car or its head unit for these checks, and no step changes a car setting.

## What to know before the drive

- **The microphone is the phone's.** The app has no access to the cabin microphone, to BMW's
  speech system or to the steering-wheel voice button. Android decides which microphone the phone
  uses; with Android Auto or Bluetooth connected that may be the phone itself or a microphone the
  car offers to the phone as a headset. Item 4 finds out which.
- **Nothing listens until the button is tapped.** Recognition starts only from a tap on the large
  round button («Говорити») and ends with the result, a second tap, or 10 seconds without a result.
  There is no wake word. The phone speaks only the answer to the question just asked.
- **The driver does not operate the phone while moving.** Every item marked *while driving* is
  done by a passenger, or with the car stopped in a safe place. If you are alone, do the
  *while driving* items parked with the engine running and repeat them later with a passenger.
- **Speech is free and browser-based.** Recognition uses Chrome's own speech service (`uk-UA`,
  online) and the answer is spoken by the phone's own Ukrainian voice. If either is not good enough
  in the car, the plan is to add a cloud speech provider behind the same button; each item below
  says which result would mean doing that.
- **Notes.** Write results in a private notes file. Never write the VIN, a token, the backend's
  address or a phone number into anything that goes into the repository.

Setup assumed: Android phone with Chrome, Android Auto (wired or wireless) or plain Bluetooth
audio to the car, the phone's hotspot giving the phone (and the car) internet, the backend reachable
over HTTPS.

---

## 1. Install the app to the home screen

- **Do (parked):** open the panel's address in Chrome, sign in («Вхід»), then Chrome menu →
  *Install app* (or *Add to home screen*). Open «Copilot» from the home screen.
- **Observe:** it opens full screen without the address bar, dark background, ring-and-dot icon;
  the assistant screen shows the button and «Натисніть і говоріть».
- **Record:** installed yes / no; opens standalone yes / no; anything that looked wrong.

  Result: ____________________

## 2. Mounting and the screen lock

- **Do (parked):** mount the phone where a passenger can reach it and the driver can see the
  state line at a glance. Leave the app open on the assistant screen for five minutes.
- **Observe:** the screen should stay on while the app is in front. Then lock the phone with the
  side button, unlock it, and tap the button again.
- **Record:** screen stayed on yes / no; after unlocking, does the button work at once; does a
  question asked just before locking finish or stop (recognition works only while the page is in
  the foreground).

  Result: ____________________

## 3. First question, parked

- **Do (parked, engine running):** tap «Говорити», ask «Як почувається авто?».
- **Observe:** the state line goes «Слухаю…» → «Думаю…» → «Відповідаю…» → back to «Натисніть і
  говоріть»; the question appears as text, the answer grows on screen and is spoken.
- **Record:** each state seen yes / no. If the screen shows «На цьому телефоні немає українського
  голосу. Відповідь показано текстом.», install a Ukrainian voice in Android's text-to-speech
  settings and repeat.
- **Cloud provider if:** no Ukrainian voice can be installed on the phone, or the voice is hard to
  understand over the car's speakers (see item 6).

  Result: ____________________

## 4. Which microphone Android uses

- **Do (parked, Android Auto or Bluetooth connected):** ask a question normally; then cover the
  phone's microphone openings with a finger and ask again; then disconnect Android Auto /
  Bluetooth and repeat both.
- **Observe:** with the phone's microphone covered, is the question still heard?
- **Record:** connected — heard with phone mic covered yes / no; disconnected — same.
  "Yes while connected" means the car's microphone reaches the phone as a headset; "no" means the
  phone's own microphone is used.
- **Cloud provider if:** neither microphone gives usable recognition at item 8 — a cloud recogniser
  copes better with distant, noisy audio.

  Result: ____________________

## 5. Call mode and music coming back

- **Do (parked, music playing through Android Auto / Bluetooth):** tap and ask a question.
- **Observe:** does the car switch to its phone-call audio mode (call screen, music cut, a different
  volume) while the phone listens or speaks? After the answer, how long until the music plays again?
- **Record:** call mode yes / no; music paused or ducked; seconds until music returns.

  Result: ____________________

## 6. The answer through the car's speakers

- **Do (parked, then *while driving* at town speed):** ask any question.
- **Observe:** does the answer play through the car's speakers or only from the phone? Is the
  volume right without touching the phone? Is it understandable over road noise?
- **Record:** car speakers yes / no; volume OK yes / no; understandable at speed yes / no.
- **Cloud provider if:** the speech is clear from the phone but not understandable through the car
  at speed — a cloud voice is clearer.

  Result: ____________________

## 7. Latency: end of speech to first spoken word

- **Do (parked, ten tries):** ask ten short questions (for example items 1–10 of the phrase list).
  A passenger times from the moment you stop speaking to the first spoken word of the answer.
- **Record:** the ten times in seconds, and the median.

  | Try | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | Median |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | Seconds | | | | | | | | | | | |

- **Cloud provider if:** the median is above 4 seconds and most of the wait is before «Думаю…»
  appears (recognition is slow). If the wait is mostly in «Думаю…», the cause is the answer, not
  speech, and a speech provider would not help.

## 8. Recognition of car phrases, standing and at motorway speed

- **Do:** ask each phrase once parked (engine running, windows closed, fan at a normal setting) and
  once *while driving* at motorway speed (a passenger taps and reads the transcript).
- **Record:** for each phrase, ✓ if the transcript on screen is right (small spelling differences
  are fine; a wrong number or unit is ✗).

  | # | Phrase | Parked | Motorway |
  |---|---|---|---|
  | 1 | Як почувається авто? | | |
  | 2 | Який тиск у шинах? | | |
  | 3 | Який тиск у задній лівій шині? | | |
  | 4 | Яка температура охолоджувальної рідини? | | |
  | 5 | Яка температура масла? | | |
  | 6 | Чи є повідомлення Check Control? | | |
  | 7 | Що означає останнє повідомлення Check Control? | | |
  | 8 | Скільки кілометрів до заправки? | | |
  | 9 | Скільки пального в баку? | | |
  | 10 | Коли наступне обслуговування? | | |
  | 11 | Скільки кілометрів до заміни масла? | | |
  | 12 | Яка напруга акумулятора? | | |
  | 13 | Чи прогрівся двигун? | | |
  | 14 | Яка зараз швидкість? | | |
  | 15 | Яка температура надворі? | | |
  | 16 | Чи нормальний тиск 2,4 бара? | | |
  | 17 | Скільки буде дев'яносто два градуси за Фаренгейтом? | | |
  | 18 | Чи можна їхати ще сто п'ятдесят кілометрів? | | |
  | 19 | Які помилки збережені в пам'яті? | | |
  | 20 | Повтори останню відповідь. | | |
  |   | **Correct (of 20)** | | |

- **Cloud provider if:** fewer than 16 of 20 are right at motorway speed, or numbers and units
  (phrases 3, 8, 11, 16–18) are wrong more than once.

## 9. Barge-in: a tap while the answer is spoken

- **Do (parked):** ask «Як почувається авто?» and tap the button («Зупинити») while the answer is
  being spoken; then tap while it shows «Думаю…».
- **Observe:** speech stops at once, nothing else is spoken afterwards, the state returns to
  «Натисніть і говоріть», and the next tap starts listening normally.
- **Record:** stopped at once yes / no; any leftover speech; next question works yes / no.

  Result: ____________________

## 10. BMW's own sounds while the phone speaks

- **Do (parked, parking brake on):** while the phone speaks an answer, cause one of the car's
  ordinary sounds the normal way: switch on the turn indicator, or open the driver's door with the
  engine running.
- **Observe:** is the car's own chime still audible over the answer?
- **Record:** chime audible yes / no. If not, stop using voice until this is understood: BMW's
  warnings must never be covered by the assistant.

  Result: ____________________

## 11. An incoming call

- **Do (parked):** have someone call the phone while it is listening, and again while it is
  speaking an answer.
- **Observe:** does the call ring normally; does the app stop listening or speaking; after the call,
  does the app return to «Натисніть і говоріть» and work on the next tap?
- **Record:** call rang normally yes / no; app state after the call; anything stuck.

  Result: ____________________

## 12. Network drop

- **Do (parked):** ask a question and switch the phone to flight mode while the answer is being
  spoken; switch it back and ask again.
- **Observe:** if the answer was still arriving, speech stops at once (mid-sentence), an error is
  shown and the state returns to «Натисніть і говоріть». If the whole answer had already arrived
  (usual for a short answer), nothing fails: it is spoken to the end and no error is shown. Either
  way the next question works once the network is back.
- **Record:** behaved as described yes / no; what the screen showed.

  Result: ____________________

---

## Summary

| Item | OK | Points to a cloud speech provider |
|---|---|---|
| 1 Install | | — |
| 2 Screen lock | | — |
| 3 First question | | |
| 4 Microphone | | |
| 5 Call mode | | — |
| 6 Car speakers | | |
| 7 Latency | | |
| 8 Recognition | | |
| 9 Barge-in | | — |
| 10 BMW chimes | | — |
| 11 Incoming call | | — |
| 12 Network drop | | — |

Date of the drive: __________  Android version: __________  Chrome version: __________
Android Auto: wired / wireless / not used
