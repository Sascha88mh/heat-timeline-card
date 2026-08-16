# Heat Timeline Card

A weekly heating schedule for Home Assistant that looks and works like the app
that came with your thermostat — a timeline you drag, not a list you read.

Built on top of the [Scheduler component][scheduler], so the schedules stay
plain Scheduler entities: editable from this card, from `scheduler-card`, or
from a service call.

## Why

Scheduler is excellent at *running* schedules, but its card presents them as
text. Reading "Von 06:00 bis 08:30 — +4 weitere Aufgaben" four times over is not
how anyone thinks about heating. This card shows the whole week as coloured
bars and lets you drag them.

## What it does

- **One card per room.** Every schedule that drives the same `climate` entity is
  grouped together, one row per weekday group, **Monday first**.
- **Drag to change.** Drag a block's edge to move the start or end, drag its
  middle to shift the whole period. Everything snaps to 15 minutes by default.
- **Drag on empty track to add.** Press where you want heat to start and pull.
  A new block stops at its neighbours — it can never swallow them.
- **Tap a block** to set its target temperature, or delete it.
- **Pick the days.** Tap a row's day label to open the weekday chips: add
  Saturday to the workweek plan, split a single day off into its own schedule,
  whatever fits. **+ Zeitplan** adds another row for the days still free,
  inheriting the room's conditions. A day claimed by two schedules is flagged.
- **Summer and Away mode built in.** Two switches in the card header, no extra
  setup: press **Modi einrichten** once and the card creates the helpers and
  attaches them to every schedule as a condition.
- **Window monitoring per room.** **Fenster (n)** opens a panel where you assign
  door/window sensors to the room; sensors sitting in the same HA area are
  offered first. Assigned windows that are currently open are highlighted, so
  you can see at a glance why a room is not heating.
- **Start from nothing.** No schedules yet? Pick a thermostat under
  **Raum hinzufügen** and the card lays down a Mo–Fr and a Sa–So plan to edit.
- **Now marker** on whichever row applies today.
- **Nothing is written until you press Save.** Until then the card shows an
  "Ungespeichert" badge and a Discard button.

Conditions you attached to a schedule (open windows, a presence flag) are
**preserved on save** — the card reads the full schedule over the Scheduler
websocket API rather than the trimmed-down entity attributes, and writes every
condition back untouched.

### How the modes behave

Both modes are plain `input_boolean` helpers, added to every managed schedule as
an "is off" condition. While either is on, no schedule heats.

Switching a mode **on** also turns the managed thermostats off right away,
because Scheduler re-applies a slot only when conditions become *valid* — it
never undoes anything when they break. Switching a mode **off** needs no action
at all: `track_conditions` makes Scheduler re-apply the current slot by itself.

One consequence worth knowing: the immediate switch-off is issued by the card.
If you flip the helper somewhere else — a dashboard toggle, a voice command —
running heat keeps running until the next slot boundary. Add a small automation
if you need that covered.

### How window monitoring behaves

Assigning a window to a room adds it to that room's schedules as an "is off"
condition. That covers one half of the job: **while a window is open, no
schedule starts heating**, and when it closes, Scheduler re-applies the block
that should be running — within a couple of seconds, no waiting for the next
slot.

It does not cover the other half. Conditions are checked when a slot fires;
they never interrupt heat that is already running. For that, switch on
**"Laufende Heizung sofort abschalten"**. The card then writes a small
automation through Home Assistant's config API — one per room, named
`<room>: Heizung aus bei offenem Fenster` — and keeps its trigger list in step
with the window list. Switching it off deletes the automation again. Nothing
else in your automation list is touched.

Both halves are optional and independent: use the condition alone if you only
want to stop schedules from firing into an open window.

## Requirements

- Home Assistant 2024.1 or newer
- [nielsfaber/scheduler-component][scheduler] installed **and added** under
  Settings → Devices & Services
- At least one Scheduler schedule whose actions target a `climate` entity

## Installation

### HACS (custom repository)

1. HACS → three-dot menu → **Custom repositories**
2. Add this repository's URL, category **Dashboard**
3. Install **Heat Timeline Card**
4. Reload your browser

### Manual

Copy `dist/heat-timeline-card.js` to `/config/www/` and add it under
Settings → Dashboards → Resources as a **JavaScript module**:
`/local/heat-timeline-card.js`

## Usage

```yaml
type: custom:heat-timeline-card
title: Heizung
```

That is the whole minimal config — every `climate` schedule is picked up
automatically.

### Options

| Option        | Type    | Default    | Description                                              |
| ------------- | ------- | ---------- | -------------------------------------------------------- |
| `title`       | string  | `Heizung`  | Card heading. Set to `false`/`""` to hide.                |
| `entities`    | list    | *all*      | Restrict to specific `climate` entities.                  |
| `step`        | number  | `15`       | Snap grid in minutes.                                     |
| `min_temp`    | number  | `5`        | Lower bound of the temperature control.                   |
| `max_temp`    | number  | `30`       | Upper bound of the temperature control.                   |
| `temp_step`   | number  | `0.5`      | Increment of the +/− buttons and the slider.              |
| `show_now`    | boolean | `true`     | Draw the "now" marker on today's row.                     |
| `show_modes`  | boolean | `true`     | Show the summer/away switches in the header.              |
| `modes.summer`| string  | `input_boolean.heat_timeline_summer` | Helper backing summer mode.     |
| `modes.away`  | string  | `input_boolean.heat_timeline_away`   | Helper backing away mode.       |

```yaml
type: custom:heat-timeline-card
title: Heizung Erdgeschoss
entities:
  - climate.wohnzimmer
  - climate.kueche
step: 30
temp_step: 0.5
```

Point `modes` at helpers you already have instead of letting the card create
its own:

```yaml
type: custom:heat-timeline-card
modes:
  summer: input_boolean.sommermodus
  away: input_boolean.unterwegs
```

## How a schedule is interpreted

A Scheduler timeslot counts as **heating** when one of its actions carries a
`temperature`. Everything else is drawn as "off". When saving, the card writes a
gap-free day: heating blocks as
`climate.set_temperature` (with `hvac_mode: heat` in the same call, so a single
action both enables the thermostat and sets the target) and the gaps between
them as `climate.set_hvac_mode: off`.

That means a schedule edited here is always a clean, contiguous day — which is
what makes the timeline unambiguous.

## Known limitations

- The card edits **times, temperatures, weekdays and window sensors**. Other
  condition types and the repeat behaviour are still set in `scheduler-card` or
  via `scheduler.add` / `scheduler.edit` — the card carries them through
  untouched.
- Window sensors are matched by `device_class`: `window`, `door`, `opening` or
  `garage_door`. A sensor without one of those will not be offered.
- Sun-relative times (`sunrise+01:00`) are not represented on the timeline yet;
  such a schedule renders from its resolved clock time.

## Development

There is no build step. `dist/heat-timeline-card.js` is the shipped artefact —
a plain ES module with no dependencies. Edit it directly.

[scheduler]: https://github.com/nielsfaber/scheduler-component
