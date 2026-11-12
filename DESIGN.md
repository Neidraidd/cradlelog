# Cradlelog: design direction

Design notes for the app. Edit freely.

## What it is, and for whom

A feed and nappy log for a baby, used by two tired parents on their phones, mostly one-handed and often at night.

## Direction

- The app is called Cradlelog; the app icon is an amber circle with a serif C.
- Keep icons on the log buttons, improved where possible.
- Dark-first, dense, no generic admin-dashboard look (a standing preference).

Dial: ENERGY 1 / RHYTHM 2 / MOTION 1

- ENERGY 1: a calm tool for 3am. The only loud thing is the "since last feed" number.
- RHYTHM 2: the log is uniform on purpose (rows to scan). Trends mixes summary boxes, a dot chart, bars, a line and a table, because each answers a different question.
- MOTION 1: the sheet slides up and buttons press in. Nothing loops.

## Decisions and why

- **Colour.** Coral is the brand colour: bottle feeds, primary actions and the "since last feed" hero gradient, because bottle feeds are what gets logged most. Lilac marks breast feeds, teal marks nappies and positive trend deltas; both are chosen to stay distinguishable from coral for colour-blind readers. Notes use plain text colour. Red is only for Delete and errors.
- **Selected states.** Selected chips, tabs and primary buttons use coral; the breast side picker uses lilac and the nappy toggles use teal, so a selection reads as "this kind of entry". On the coral hero, warnings turn pale yellow so they stay readable.
- **Theme.** Follows the phone's setting. Dark is the default because most feeds happen in a dark room.
- **Type.** The phone's own system font throughout, including the wordmark: fastest to load, works offline, and the most legible at small sizes on each device.
- **Identity motif.** A feed is a dot, and its size shows how much was taken. The same rule is used for the dots in the log and in the "When feeds happen" chart, and the icon itself is a dot.
- **Icons.** One drawn set (bottle, cradled baby, nappy, pencil, drop, poo, face) so every phone shows the same marks; emoji look different on iPhone and Android.
- **Layout.** A coral gradient hero answers "when was the last feed?" with a progress track through the feed window, then the four log buttons as tinted tiles, a Today totals card, then the history. Home/Trends sit in a floating pill nav at the bottom, in thumb reach; the toast sits above it. No sidebar or dashboard frame.
- **Started feeds.** "Start feed now" logs the start time so the clocks count from the start, not the end. Until the amount is added, the feed is marked "in progress" with a dashed amber outline, a hollow dot and the words "In progress · add amount", so it reads as unfinished without relying on colour.
- **Continue feed.** A started feed can be saved part-way: "Continue feed" stores the amount so far and leaves the feed open, so a bottle that takes two sittings stays one feed. "Finish feed" records an end time (default now, with −5/−15/−30/−60 chips) and the length shows as a minutes tag in the log plus a 7-day average on Trends. A feed left open for an hour ends itself at the last time the amount went up (a bottle can't be used after an hour), so 40 ml by 29 minutes and nothing since is a 29 minute feed. With no amount ever saved it ends with no length, and the phones get one "Feed ended" alert. "Forgot to end" is still there for a feed that really finished earlier but wasn't closed: it saves it without a length. Length is only ever stored on Finish.
- **Undo, not "are you sure?".** Saving, starting and deleting all happen straight away, with an Undo in the message bar for 8 seconds. One tap instead of two, and it also catches a mis-tapped amount.
- **Weight.** Weigh-ins are rare, so they don't get a home-screen button: they're added from the Weight card on Trends and show in the log as square markers. Each phone picks kg or lb and oz; the other unit is always shown in brackets.
- **Alerts.** Per phone, off by default: one notification when the feed window opens, one if it's missed, one when a started feed with no amount ends itself after an hour. Each fires once per feed and stale ones are skipped, so a restart can't send a burst.
- **Next-feed countdown.** A second, smaller clock inside the hero under the big one, so "since last feed" stays the focal point. It's worked out from the family's "every X to Y hours" setting and always says its state in words ("in 1h 50m", "40m left", "1h overdue"), not by colour alone.
- **Spacing and shape.** Large soft corners (22-28px on cards and sheets, pill chips and nav), circular steppers, a drag handle on the bottom sheets, 44px minimum for anything you tap.
- **Contrast.** Every text colour pair was run through the antislop contrast checker (4.5:1 for text, 3:1 for control edges and focus rings).
