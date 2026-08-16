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
  grouped together, one row per weekday group (Mo–Fr, Sa–So, or whatever you set
  up).
- **Drag to change.** Drag a block's edge to move the start or end, drag its
  middle to shift the whole period. Everything snaps to 15 minutes by default.
- **Drag on empty track to add.** Press where you want heat to start and pull.
- **Tap a block** to set its target temperature, or delete it.
- **Now marker** on whichever row applies today.
- **Nothing is written until you press Save.** Until then the card shows an
  "Ungespeichert" badge and a Discard button.

Conditions you attached to a schedule (open windows, a summer-mode toggle, a
presence flag) are **preserved on save** — the card reads the full schedule over
the Scheduler websocket API rather than the trimmed-down entity attributes, and
writes every condition back untouched.

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

| Option      | Type    | Default    | Description                                              |
| ----------- | ------- | ---------- | -------------------------------------------------------- |
| `title`     | string  | `Heizung`  | Card heading. Set to `false`/`""` to hide.                |
| `entities`  | list    | *all*      | Restrict to specific `climate` entities.                  |
| `step`      | number  | `15`       | Snap grid in minutes.                                     |
| `min_temp`  | number  | `5`        | Lower bound of the temperature control.                   |
| `max_temp`  | number  | `30`       | Upper bound of the temperature control.                   |
| `temp_step` | number  | `0.5`      | Increment of the +/− buttons and the slider.              |
| `show_now`  | boolean | `true`     | Draw the "now" marker on today's row.                     |

```yaml
type: custom:heat-timeline-card
title: Heizung Erdgeschoss
entities:
  - climate.wohnzimmer
  - climate.kueche
step: 30
temp_step: 0.5
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

- The card edits **times and temperatures**. Weekday groups, conditions and
  repeat behaviour are still set in `scheduler-card` or via
  `scheduler.add` / `scheduler.edit`.
- Sun-relative times (`sunrise+01:00`) are not represented on the timeline yet;
  such a schedule renders from its resolved clock time.

## Development

There is no build step. `dist/heat-timeline-card.js` is the shipped artefact —
a plain ES module with no dependencies. Edit it directly.

[scheduler]: https://github.com/nielsfaber/scheduler-component
