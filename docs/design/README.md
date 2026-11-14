A quiet instrument for one driver. Two surfaces share this system: the app drawn on the car's centre display (1920 × 720, landscape, glanced at from arm's length) and the phone companion (portrait, used with one thumb). Everything is dark, still and legible; the assistant speaks only when asked or when the car itself reports something.

## Content

- Write interface copy in Ukrainian, sentence case, no exclamation marks, no emoji. Labels are upper case and set in `label`.
- Say only what the car reported. A value the car did not send is shown as «Недоступно» with the reason under it, never as a dash, a zero or an estimate.
- Every warning names where it comes from, as a tag set in `label`: «BMW CHECK CONTROL», «СЕРВІС BMW», «ПАМ'ЯТЬ ПОМИЛОК BMW», «ВАШ ЛІМІТ». A limit the owner typed in is always called the owner's, never the manufacturer's. «ПАМ'ЯТЬ ПОМИЛОК BMW» marks a fault code read from a control unit's fault memory; whether it is active now is stated with the code.
- Every warning also names its severity as a word: «КРИТИЧНО» (critical), «ПОПЕРЕДЖЕННЯ» (warning), «ДО ВІДОМА» (information).
- A warning the car no longer reports says so in words at the end of its tag line: «ЗНЯТО О 12:39», «ЗНЯТО ВЧОРА», «ЗНЯТО 9 ЛИСТОПАДА», or «ЗНЯТО» when the time is unknown; it is listed after the active ones.
- Say how current the readings are. The phone's car page heads them «ЗАРАЗ · ОНОВЛЕНО О 12:41» only while the car is reporting; otherwise «ОСТАННІ ДАНІ · ОНОВЛЕНО ВЧОРА О 18:42» with the reason under it. Scripted demo data is always marked «ДЕМО-ДАНІ», with the line «Імітовані показники і сповіщення, а не дані вашого авто.»
- Numbers carry their unit after a space: «92 °C», «452 км», «2,3 бар». Decimal comma. Use the units the car displays.
- While the car is moving an answer is three lines at most, set in `answer-driving`. Standing, up to eight lines in `answer`.
- The assistant advises and never commands the car: «перевірте при нагоді», not «зупиніться негайно», unless the car's own message says so.
- Do not use the car maker's name, logo or marks as branding. The product is called AI Copilot; on screen it is «Copilot».

## Colour

- Paint the screen in `ground`. Put panels in `surface` and tiles, chips and rows in `surface-raised`; separate them with `space-2` gaps or a `line` hairline, never with shadows or gradients.
- Set text in `ink`; labels, units and notes in `ink-dim`.
- `signal` belongs to the assistant: the push-to-talk button, the active tab, a connected-state dot, links. One `signal` fill per screen; text on it is `on-signal`.
- Severity is `warning` or `critical` and always comes with an icon and a word. Never colour a reading by itself to say it is good or bad: there is no green. A normal reading is plain `ink`.
- An unavailable reading keeps its tile, drawn with a dashed `line-strong` edge and `ink-dim` text.

## Type

- One family, Ubuntu Sans, the face the head unit draws with. Readings are light (`reading-xl`, `reading`), text is regular, headings and labels medium.
- Nothing on the car screen is smaller than `label` (18px). Nothing on the phone is smaller than `phone-label` (13px).

## Layout

- Car screen: the left 104px column and the top-right corner (440 × 72px) belong to the head unit's own interface; leave them empty. The app's header is 72px tall: name, tabs, status pills. Content sits inside a `space-5` margin.
- Touch targets on the car screen are at least 88px tall; on the phone at least 48px.
- While moving, show one answer, at most three chips and three readings. No keyboard, no scrolling lists, no multi-step actions.
- The in-car pop-up is one `surface-raised` box with a `line-strong` edge, a severity icon, the car's own words, one line of advice and one button. It never covers the whole screen and closes by itself.
- Corners: `radius-md` for every box, `radius-pill` for pills, the push-to-talk button and meter bars.

## Motion

- None on the car screen: a frame is drawn only when a value changes. No spinners, no transitions, no pulsing.
- On the phone the only moving element is the level meter while listening or speaking.

## Iconography

- Inline stroke icons, 2px stroke, round caps, drawn in the text colour. Severity shapes differ as well as colours: a triangle for `warning`, an octagon for `critical`, a circle for information.
- No pictograms of the car, no gauges with needles, no decorative illustration.
