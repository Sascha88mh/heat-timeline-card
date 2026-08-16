/*!
 * Heat Timeline Card for Home Assistant
 * A touch-friendly weekly heating timeline on top of the Scheduler component.
 *
 * No build step, no dependencies — plain ES module + custom element.
 * All markup is built through the DOM, never through string interpolation,
 * so entity names and user config can never inject markup.
 */

const VERSION = "0.2.0";
const DAY = 1440;

/* ------------------------------------------------------------------ utils */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** "06:30:00" -> 390 */
function toMin(hhmmss) {
  const m = String(hhmmss || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : 0;
}

/** 390 -> "06:30:00"; 1440 wraps to midnight, which is how Scheduler ends a day */
function toTime(min) {
  const v = Math.round(min) % DAY;
  return (
    String(Math.floor(v / 60)).padStart(2, "0") +
    ":" +
    String(v % 60).padStart(2, "0") +
    ":00"
  );
}

function fmt(min) {
  const v = Math.round(min) % DAY;
  return (
    String(Math.floor(v / 60)).padStart(2, "0") +
    ":" +
    String(v % 60).padStart(2, "0")
  );
}

const fmtTemp = (t) => String(t).replace(/\.0$/, "") + " °";

/** Build an element. Children are text nodes or elements — never raw HTML. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const key of Object.keys(props || {})) {
    const v = props[key];
    if (v === null || v === undefined || v === false) continue;
    if (key === "class") el.className = v;
    else if (key === "text") el.textContent = String(v);
    else if (key === "style") Object.assign(el.style, v);
    else if (key.slice(0, 2) === "on") el.addEventListener(key.slice(2), v);
    else el.setAttribute(key, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.appendChild(typeof kid === "object" ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEK_LABEL = {
  mon: "Mo", tue: "Di", wed: "Mi", thu: "Do", fri: "Fr", sat: "Sa", sun: "So",
};

/** Scheduler accepts daily/workday/weekend tokens — expand them to real days. */
function expandDays(days) {
  const d = (days || []).map((x) => String(x).toLowerCase());
  if (d.includes("daily")) return WEEK.slice();
  const out = new Set();
  for (const x of d) {
    if (x === "workday") ["mon", "tue", "wed", "thu", "fri"].forEach((y) => out.add(y));
    else if (x === "weekend") ["sat", "sun"].forEach((y) => out.add(y));
    else if (WEEK.includes(x)) out.add(x);
  }
  return WEEK.filter((x) => out.has(x));
}

/** Compact label for a set of weekdays: Mo–Fr, Sa–So, Täglich, or Mo, Mi, Fr */
function daysLabel(days) {
  const idx = expandDays(days);
  if (idx.length === 7) return "Täglich";
  if (idx.length === 0) return "—";
  if (idx.length === 5 && !idx.includes("sat") && !idx.includes("sun")) return "Mo–Fr";
  if (idx.length === 2 && idx.includes("sat") && idx.includes("sun")) return "Sa–So";
  const pos = idx.map((x) => WEEK.indexOf(x));
  const run = pos.every((p, i) => i === 0 || p === pos[i - 1] + 1);
  if (run && pos.length > 2)
    return WEEK_LABEL[idx[0]] + "–" + WEEK_LABEL[idx[idx.length - 1]];
  return idx.map((x) => WEEK_LABEL[x]).join(", ");
}

/** Sort key so Monday always comes first and Sunday last. */
function daySortKey(days) {
  const idx = expandDays(days).map((x) => WEEK.indexOf(x));
  return idx.length ? Math.min(...idx) : 99;
}

/** Does this weekday set cover "today"? */
function coversToday(days) {
  return expandDays(days).includes(WEEK[(new Date().getDay() + 6) % 7]);
}

/* -------------------------------------------------- schedule <-> blocks */

/**
 * A Scheduler timeslot counts as "heating" when one of its actions carries a
 * temperature. Everything else is treated as "off".
 */
function slotTemp(slot) {
  for (const a of slot.actions || []) {
    const t = (a.service_data || a.data || {}).temperature;
    if (t !== undefined && t !== null) return Number(t);
  }
  return null;
}

/** Timeslots -> sorted heat blocks. */
function toBlocks(item) {
  const out = [];
  for (const s of item.timeslots || []) {
    const t = slotTemp(s);
    if (t === null) continue;
    const a = toMin(s.start);
    let b = s.stop ? toMin(s.stop) : a + 60;
    if (b <= a) b = DAY;
    out.push({ start: a, stop: b, temp: t });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** The climate entity this schedule drives. */
function scheduleEntity(item) {
  for (const s of item.timeslots || [])
    for (const a of s.actions || []) if (a.entity_id) return a.entity_id;
  return null;
}

/**
 * Scheduler reports conditions with `attribute: null`, but its own `edit`
 * schema rejects a null there ("string value is None"). Round-tripping a
 * schedule therefore has to drop empty keys first.
 */
function cleanConditions(conditions) {
  return (conditions || []).map((c) => {
    const out = {};
    for (const k of Object.keys(c))
      if (c[k] !== null && c[k] !== undefined) out[k] = c[k];
    return out;
  });
}

/** Make sure the mode switches are present as "must be off" conditions. */
function withModeConditions(conditions, modes) {
  const out = cleanConditions(conditions);
  for (const ent of [modes.summer, modes.away]) {
    if (!ent) continue;
    if (!out.some((c) => c.entity_id === ent))
      out.push({ entity_id: ent, value: "off", match_type: "is" });
  }
  return out;
}

/**
 * Heat blocks -> full-day timeslots, re-using the conditions and action shape
 * of the existing schedule so nothing is silently dropped on save.
 */
function toTimeslots(item, blocks, modes) {
  const first = (item.timeslots || [])[0] || {};
  const entity = scheduleEntity(item);
  const base = {
    conditions: withModeConditions(first.conditions, modes || {}),
    condition_type: first.condition_type || "and",
    track_conditions:
      first.track_conditions === undefined ? true : first.track_conditions,
  };
  const off = (a, b) =>
    Object.assign({ start: toTime(a), stop: toTime(b) }, base, {
      actions: [
        {
          entity_id: entity,
          service: "climate.set_hvac_mode",
          service_data: { hvac_mode: "off" },
        },
      ],
    });
  const heat = (blk) =>
    Object.assign({ start: toTime(blk.start), stop: toTime(blk.stop) }, base, {
      actions: [
        {
          entity_id: entity,
          service: "climate.set_temperature",
          // hvac_mode travels with the temperature so one action both enables
          // heating and sets the target
          service_data: { temperature: Number(blk.temp), hvac_mode: "heat" },
        },
      ],
    });

  const sorted = blocks.slice().sort((a, b) => a.start - b.start);
  const slots = [];
  let cur = 0;
  for (const b of sorted) {
    if (b.start > cur) slots.push(off(cur, b.start));
    slots.push(heat(b));
    cur = b.stop;
  }
  if (cur < DAY) slots.push(off(cur, DAY));
  return slots;
}

/** Keep blocks sorted, inside the day, and free of overlaps. */
function normalise(blocks, minLen) {
  const out = blocks
    .map((b) => ({
      temp: b.temp,
      start: clamp(Math.round(b.start), 0, DAY - minLen),
      stop: clamp(Math.round(b.stop), minLen, DAY),
    }))
    .filter((b) => b.stop - b.start >= minLen)
    .sort((a, b) => a.start - b.start);

  for (let i = 1; i < out.length; i++)
    if (out[i].start < out[i - 1].stop) out[i].start = out[i - 1].stop;

  return out.filter((b) => b.stop - b.start >= minLen);
}

/** The free stretch around `at`, so a new block can never swallow its neighbours. */
function gapAround(blocks, at) {
  let lo = 0;
  let hi = DAY;
  for (const b of blocks) {
    if (b.stop <= at) lo = Math.max(lo, b.stop);
    if (b.start >= at) {
      hi = Math.min(hi, b.start);
      break;
    }
  }
  return { lo, hi };
}

/* ------------------------------------------------------------------- card */

class HeatTimelineCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._items = [];   // schedules straight from the scheduler websocket api
    this._draft = {};   // schedule_id -> blocks being edited
    this._days = {};    // schedule_id -> weekdays being edited
    this._dirty = {};   // schedule_id -> true
    this._edit = null;  // {id, index} of the open block editor
    this._open = {};    // schedule_id -> day/settings strip expanded
    this._loaded = false;
    this._drag = null;
    this._tick = null;
    this._busy = false;
  }

  static getStubConfig() {
    return { title: "Heizung" };
  }

  setConfig(config) {
    const cfg = Object.assign(
      {
        title: "Heizung",
        step: 15,
        min_temp: 5,
        max_temp: 30,
        temp_step: 0.5,
        show_now: true,
        show_modes: true,
        entities: null,
        modes: {},
      },
      config || {}
    );
    cfg.modes = Object.assign(
      {
        summer: "input_boolean.heat_timeline_summer",
        away: "input_boolean.heat_timeline_away",
      },
      config && config.modes ? config.modes : {}
    );
    this._config = cfg;
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._load();
    else if (this._loaded && !this._drag) this._render();
  }

  getCardSize() {
    return 3 + this._rooms().length * 3;
  }

  connectedCallback() {
    // keeps the "now" marker honest without hammering the browser
    this._tick = setInterval(() => {
      if (this._loaded && !this._drag) this._render();
    }, 60000);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
  }

  /* ------------------------------------------------------------ data */

  async _load() {
    try {
      this._items = await this._hass.connection.sendMessagePromise({
        type: "scheduler",
      });
      this._loaded = true;
      this._hass.connection.subscribeEvents(
        () => this._reload(),
        "scheduler_updated"
      );
    } catch (e) {
      this._items = [];
      this._loaded = true;
      this._error =
        "Die Scheduler-Integration antwortet nicht. Ist sie installiert und " +
        "unter Einstellungen → Geräte & Dienste hinzugefügt?";
    }
    this._render();
  }

  async _reload() {
    if (Object.keys(this._dirty).length) return; // never stomp on unsaved edits
    try {
      this._items = await this._hass.connection.sendMessagePromise({
        type: "scheduler",
      });
      this._draft = {};
      this._days = {};
      this._render();
    } catch (e) {
      /* keep showing the previous data */
    }
  }

  _blocks(item) {
    if (!this._draft[item.schedule_id])
      this._draft[item.schedule_id] = toBlocks(item);
    return this._draft[item.schedule_id];
  }

  _weekdays(item) {
    if (!this._days[item.schedule_id])
      this._days[item.schedule_id] = expandDays(item.weekdays);
    return this._days[item.schedule_id];
  }

  _itemById(id) {
    return this._items.find((x) => x.schedule_id === id);
  }

  /** Schedules grouped by the climate entity they control, Monday first. */
  _rooms() {
    const want = this._config && this._config.entities;
    const map = new Map();
    for (const it of this._items) {
      const ent = scheduleEntity(it);
      if (!ent || ent.slice(0, 8) !== "climate.") continue;
      if (want && want.indexOf(ent) === -1) continue;
      if (!map.has(ent)) map.set(ent, []);
      map.get(ent).push(it);
    }
    for (const list of map.values())
      list.sort(
        (a, b) =>
          daySortKey(this._days[a.schedule_id] || a.weekdays) -
            daySortKey(this._days[b.schedule_id] || b.weekdays) ||
          String(a.name || "").localeCompare(String(b.name || ""))
      );
    return [...map.entries()].map(([entity, schedules]) => ({ entity, schedules }));
  }

  /* ------------------------------------------------------------ modes */

  _modeState(which) {
    const ent = this._config.modes[which];
    const st = ent && this._hass.states[ent];
    return st ? st.state === "on" : null; // null = helper missing
  }

  _modesReady() {
    return ["summer", "away"].every((k) => this._modeState(k) !== null);
  }

  /** Create the two mode helpers this package needs, then attach them. */
  async _setupModes() {
    if (this._busy) return;
    this._busy = true;
    this._render();
    const wanted = [
      ["summer", "Sommermodus", "mdi:white-balance-sunny"],
      ["away", "Unterwegs", "mdi:bag-suitcase"],
    ];
    try {
      for (const [key, name, icon] of wanted) {
        const ent = this._config.modes[key];
        if (!ent || this._hass.states[ent]) continue;
        await this._hass.connection.sendMessagePromise({
          type: "input_boolean/create",
          name: name,
          icon: icon,
        });
      }
      // attach them as conditions to every schedule this card manages
      for (const room of this._rooms())
        for (const item of room.schedules) await this._save(item, true);
    } catch (e) {
      this._error = "Die Modus-Schalter konnten nicht angelegt werden: " + e.message;
    }
    this._busy = false;
    await this._reload();
  }

  async _toggleMode(which) {
    const ent = this._config.modes[which];
    if (!ent) return;
    const on = this._modeState(which);
    await this._hass.callService("input_boolean", on ? "turn_off" : "turn_on", {
      entity_id: ent,
    });
    if (!on) {
      // Turning a mode ON has to stop current heating: Scheduler only re-applies
      // actions when conditions become *valid* again, never when they break.
      const targets = this._rooms().map((r) => r.entity);
      if (targets.length)
        await this._hass.callService("climate", "set_hvac_mode", {
          entity_id: targets,
          hvac_mode: "off",
        });
    }
    // Turning it OFF needs no action: track_conditions re-applies the slot.
  }

  /* ----------------------------------------------------------- writing */

  async _save(item, quiet) {
    const blocks = normalise(this._blocks(item), this._config.step);
    this._draft[item.schedule_id] = blocks;
    const days = this._weekdays(item);
    const data = {
      entity_id: item.entity_id,
      weekdays: days.length ? days : ["daily"],
      repeat_type: item.repeat_type || "repeat",
      timeslots: toTimeslots(item, blocks, this._config.modes),
    };
    if (item.name) data.name = item.name;
    try {
      await this._hass.callService("scheduler", "edit", data);
      delete this._dirty[item.schedule_id];
      if (!quiet) this._flash(item.schedule_id, "ok");
    } catch (e) {
      if (!quiet) this._flash(item.schedule_id, "err");
    }
    if (!quiet) this._render();
  }

  _revert(item) {
    delete this._draft[item.schedule_id];
    delete this._days[item.schedule_id];
    delete this._dirty[item.schedule_id];
    this._edit = null;
    this._render();
  }

  /** New schedule for a room, inheriting conditions from an existing one. */
  async _addSchedule(room) {
    if (this._busy) return;
    this._busy = true;
    this._render();
    const template = room.schedules[0];
    const used = new Set();
    for (const s of room.schedules)
      for (const d of expandDays(this._days[s.schedule_id] || s.weekdays)) used.add(d);
    const free = WEEK.filter((d) => !used.has(d));
    const days = free.length ? free : WEEK.slice();

    const conditions = withModeConditions(
      template ? (template.timeslots[0] || {}).conditions : [],
      this._config.modes
    );
    const base = {
      conditions,
      condition_type: (template && template.timeslots[0].condition_type) || "and",
      track_conditions: true,
    };
    const mk = (start, stop, temp) =>
      Object.assign({ start: toTime(start), stop: toTime(stop) }, base, {
        actions: [
          temp === null
            ? {
                entity_id: room.entity,
                service: "climate.set_hvac_mode",
                service_data: { hvac_mode: "off" },
              }
            : {
                entity_id: room.entity,
                service: "climate.set_temperature",
                service_data: { temperature: temp, hvac_mode: "heat" },
              },
        ],
      });
    const st = this._hass.states[room.entity];
    const name = (st && st.attributes.friendly_name) || room.entity.split(".")[1];
    try {
      await this._hass.callService("scheduler", "add", {
        name: name + " " + daysLabel(days),
        weekdays: days,
        repeat_type: "repeat",
        timeslots: [mk(0, 360, null), mk(360, 1320, 20), mk(1320, DAY, null)],
      });
    } catch (e) {
      this._error = "Zeitplan konnte nicht angelegt werden: " + e.message;
    }
    this._busy = false;
    await this._reload();
  }

  async _removeSchedule(item) {
    if (this._busy) return;
    this._busy = true;
    this._render();
    try {
      await this._hass.callService("scheduler", "remove", {
        entity_id: item.entity_id,
      });
    } catch (e) {
      this._error = "Zeitplan konnte nicht gelöscht werden: " + e.message;
    }
    delete this._draft[item.schedule_id];
    delete this._days[item.schedule_id];
    delete this._dirty[item.schedule_id];
    this._busy = false;
    await this._reload();
  }

  _flash(id, kind) {
    this._flashState = { id, kind };
    setTimeout(() => {
      this._flashState = null;
      this._render();
    }, 1600);
  }

  /* -------------------------------------------------------- rendering */

  _render() {
    if (!this.shadowRoot || !this._config) return;
    if (!this._card) {
      const style = document.createElement("style");
      style.textContent = CSS;
      this.shadowRoot.appendChild(style);
      this._card = document.createElement("ha-card");
      this.shadowRoot.appendChild(this._card);
    }

    const kids = [];
    if (!this._hass || !this._loaded) {
      kids.push(h("div", { class: "pad muted", text: "Lade Zeitpläne…" }));
    } else if (this._error) {
      kids.push(h("div", { class: "pad err", text: this._error }));
    } else {
      const rooms = this._rooms();
      if (this._config.title || this._config.show_modes)
        kids.push(this._header());
      if (!rooms.length)
        kids.push(
          h("div", {
            class: "pad muted",
            text:
              "Keine Heiz-Zeitpläne gefunden. Lege im Scheduler einen Zeitplan " +
              "für ein climate-Gerät an.",
          })
        );
      else for (const r of rooms) kids.push(this._room(r));
    }
    this._card.replaceChildren(...kids);
  }

  _header() {
    const kids = [];
    if (this._config.title)
      kids.push(h("div", { class: "hdr-title", text: this._config.title }));
    kids.push(h("span", { class: "grow" }));

    if (this._config.show_modes) {
      if (!this._modesReady()) {
        kids.push(
          h("button", {
            class: "btn ghost sm",
            text: this._busy ? "Wird angelegt…" : "Modi einrichten",
            disabled: this._busy ? "true" : null,
            onclick: () => this._setupModes(),
          })
        );
      } else {
        const chip = (which, label) => {
          const on = this._modeState(which);
          return h("button", {
            class: "mode" + (on ? " on" : ""),
            text: label,
            onclick: () => this._toggleMode(which),
          });
        };
        kids.push(chip("summer", "Sommer"), chip("away", "Unterwegs"));
      }
    }
    return h("div", { class: "hdr" }, kids);
  }

  _room(room) {
    const st = this._hass.states[room.entity];
    const name = (st && st.attributes.friendly_name) || room.entity.split(".")[1];
    const cur = st && st.attributes.current_temperature;
    const heating = st && st.state === "heat";
    const target = st && st.attributes.temperature;
    const dirty = room.schedules.some((s) => this._dirty[s.schedule_id]);
    const flash =
      this._flashState &&
      room.schedules.some((s) => s.schedule_id === this._flashState.id)
        ? this._flashState.kind
        : null;

    // days claimed by more than one schedule of this room
    const seen = {};
    const clash = new Set();
    for (const s of room.schedules)
      for (const d of expandDays(this._days[s.schedule_id] || s.weekdays)) {
        if (seen[d]) clash.add(d);
        seen[d] = true;
      }

    const head = h(
      "div",
      { class: "room-hd" },
      h("span", { class: "dot" + (heating ? " on" : "") }),
      h("span", { class: "room-name", text: name }),
      h("span", { class: "grow" }),
      flash === "ok"
        ? h("span", { class: "pill ok", text: "Gespeichert" })
        : flash === "err"
        ? h("span", { class: "pill err", text: "Fehler" })
        : dirty
        ? h("span", { class: "pill warn", text: "Ungespeichert" })
        : null,
      h("span", {
        class: "temp",
        text:
          cur === undefined || cur === null
            ? "--"
            : Math.round(cur * 10) / 10 + "°",
      }),
      heating && target !== undefined && target !== null
        ? h("span", {
            class: "target",
            text: "→" + String(target).replace(/\.0$/, "") + "°",
          })
        : null
    );

    const scale = h(
      "div",
      { class: "scale" },
      [0, 3, 6, 9, 12, 15, 18, 21].map((x) => h("span", { text: String(x) })),
      h("span", { class: "last", text: "24" })
    );

    const foot = h(
      "div",
      { class: "actions" },
      clash.size
        ? h("span", {
            class: "pill err",
            text:
              "Doppelt belegt: " +
              [...clash].map((d) => WEEK_LABEL[d]).join(", "),
          })
        : null,
      h("span", { class: "grow" }),
      h("button", {
        class: "btn ghost sm",
        text: "+ Zeitplan",
        disabled: this._busy ? "true" : null,
        onclick: () => this._addSchedule(room),
      }),
      dirty
        ? h("button", {
            class: "btn ghost sm",
            text: "Verwerfen",
            onclick: () => {
              this._edit = null;
              room.schedules.forEach((s) => this._revert(s));
            },
          })
        : null,
      dirty
        ? h("button", {
            class: "btn primary sm",
            text: "Speichern",
            onclick: () => {
              this._edit = null;
              room.schedules.forEach(
                (s) => this._dirty[s.schedule_id] && this._save(s)
              );
            },
          })
        : null
    );

    return h(
      "div",
      { class: "room" },
      head,
      room.schedules.map((s) => this._row(s)),
      scale,
      foot
    );
  }

  _row(item) {
    const id = item.schedule_id;
    const blocks = normalise(this._blocks(item), this._config.step);
    this._draft[id] = blocks;
    const days = this._weekdays(item);
    const today = coversToday(days);
    const now = new Date();

    const track = h("div", {
      class: "track",
      onpointerdown: (e) => this._down(e, track, id),
    });
    track.dataset.sched = id;

    blocks.forEach((b, i) => {
      const open = this._edit && this._edit.id === id && this._edit.index === i;
      const w = ((b.stop - b.start) * 100) / DAY;
      const blk = h(
        "div",
        {
          class: "blk" + (open ? " open" : ""),
          style: {
            left: ((b.start * 100) / DAY).toFixed(3) + "%",
            width: w.toFixed(3) + "%",
          },
        },
        h("span", { class: "h left", "data-edge": "start" }),
        h("span", { class: "lbl", text: w > 7 ? fmtTemp(b.temp) : "" }),
        h("span", { class: "h right", "data-edge": "stop" })
      );
      blk.dataset.i = String(i);
      track.appendChild(blk);
    });

    if (this._config.show_now && today) {
      const pct = ((now.getHours() * 60 + now.getMinutes()) * 100) / DAY;
      track.appendChild(
        h("div", { class: "now", style: { left: pct.toFixed(2) + "%" } })
      );
    }

    const row = h(
      "div",
      { class: "row" },
      h("button", {
        class: "row-lbl" + (today ? " today" : "") + (this._open[id] ? " sel" : ""),
        text: daysLabel(days),
        onclick: () => {
          this._open[id] = !this._open[id];
          this._render();
        },
      }),
      track
    );

    const extras = [row];
    if (this._open[id]) extras.push(this._daysStrip(item, days));
    const ed = this._editor(item, blocks);
    if (ed) extras.push(ed);
    return extras.length === 1 ? row : h("div", { class: "rowwrap" }, extras);
  }

  _daysStrip(item, days) {
    const id = item.schedule_id;
    const set = new Set(days);
    const chips = WEEK.map((d) =>
      h("button", {
        class: "day" + (set.has(d) ? " on" : ""),
        text: WEEK_LABEL[d],
        onclick: () => {
          const cur = new Set(this._weekdays(item));
          if (cur.has(d)) cur.delete(d);
          else cur.add(d);
          this._days[id] = WEEK.filter((x) => cur.has(x));
          this._dirty[id] = true;
          this._render();
        },
      })
    );
    return h(
      "div",
      { class: "days" },
      chips,
      h("span", { class: "grow" }),
      h("button", {
        class: "btn ghost sm danger",
        text: "Zeitplan löschen",
        disabled: this._busy ? "true" : null,
        onclick: () => this._removeSchedule(item),
      })
    );
  }

  _editor(item, blocks) {
    const id = item.schedule_id;
    if (!this._edit || this._edit.id !== id) return null;
    const b = blocks[this._edit.index];
    if (!b) return null;

    // Every render rebuilds the block objects, so handlers must resolve the
    // current one instead of closing over a stale reference.
    const live = () => {
      const list = this._draft[id];
      return this._edit && list ? list[this._edit.index] : null;
    };

    const big = h("div", { class: "big", text: fmtTemp(b.temp) });
    const bump = (delta) => {
      const cur = live();
      if (!cur) return;
      cur.temp = clamp(
        Math.round((cur.temp + delta) / this._config.temp_step) *
          this._config.temp_step,
        this._config.min_temp,
        this._config.max_temp
      );
      this._dirty[id] = true;
      this._render();
    };

    const slider = h("input", {
      class: "slider",
      type: "range",
      min: this._config.min_temp,
      max: this._config.max_temp,
      step: this._config.temp_step,
      value: b.temp,
      oninput: (e) => {
        const cur = live();
        if (!cur) return;
        cur.temp = Number(e.target.value);
        this._dirty[id] = true;
        big.textContent = fmtTemp(cur.temp);
        const el = this._card.querySelector(
          '.track[data-sched="' + id + '"] .blk[data-i="' + this._edit.index + '"] .lbl'
        );
        if (el && el.textContent) el.textContent = fmtTemp(cur.temp);
      },
    });

    return h(
      "div",
      { class: "editor" },
      h(
        "div",
        { class: "ed-row" },
        h("span", { class: "ed-t", text: fmt(b.start) + " – " + fmt(b.stop) }),
        h("span", { class: "grow" }),
        h("button", {
          class: "btn ghost sm",
          text: "Block löschen",
          onclick: () => {
            const list = this._draft[id];
            if (!list || !this._edit) return;
            list.splice(this._edit.index, 1);
            this._dirty[id] = true;
            this._edit = null;
            this._render();
          },
        })
      ),
      h(
        "div",
        { class: "ed-row" },
        h("button", { class: "step", text: "−", onclick: () => bump(-this._config.temp_step) }),
        big,
        h("button", { class: "step", text: "+", onclick: () => bump(this._config.temp_step) }),
        slider
      )
    );
  }

  /* ------------------------------------------------------ interaction */

  _pos(e, track) {
    const rect = track.getBoundingClientRect();
    return clamp((e.clientX - rect.left) / rect.width, 0, 1) * DAY;
  }

  _snap(min) {
    const s = this._config.step;
    return clamp(Math.round(min / s) * s, 0, DAY);
  }

  _down(e, track, id) {
    const item = this._itemById(id);
    if (!item) return;
    const blocks = normalise(this._blocks(item), this._config.step);
    this._draft[id] = blocks;

    const blkEl = e.target.closest ? e.target.closest(".blk") : null;
    const edge = e.target.getAttribute && e.target.getAttribute("data-edge");
    const at = this._pos(e, track);

    if (blkEl) {
      const i = Number(blkEl.dataset.i);
      this._drag = {
        id, i, track,
        mode: edge || "move",
        grab: at,
        orig: Object.assign({}, blocks[i]),
        moved: false,
        gap: gapAround(blocks.filter((_, k) => k !== i), at),
      };
    } else {
      // New block, confined to the free stretch it was started in, so it can
      // never swallow the blocks around it.
      const gap = gapAround(blocks, at);
      if (gap.hi - gap.lo < this._config.step) return;
      const start = clamp(this._snap(at), gap.lo, gap.hi - this._config.step);
      const nb = { start, stop: Math.min(start + this._config.step, gap.hi), temp: 20 };
      const sorted = blocks.concat([nb]).sort((a, b) => a.start - b.start);
      this._draft[id] = sorted;
      this._dirty[id] = true;
      this._drag = {
        id,
        i: sorted.indexOf(nb),
        track,
        mode: "stop",
        grab: at,
        orig: Object.assign({}, nb),
        moved: true,
        created: true,
        gap,
      };
      this._render();
    }

    const live = this._card.querySelector('.track[data-sched="' + id + '"]') || track;
    if (this._drag) this._drag.track = live;

    const move = (ev) => this._move(ev);
    const up = (ev) => {
      try {
        live.releasePointerCapture(ev.pointerId);
      } catch (err) {
        /* already released */
      }
      live.removeEventListener("pointermove", move);
      live.removeEventListener("pointerup", up);
      live.removeEventListener("pointercancel", up);
      this._up();
    };
    try {
      live.setPointerCapture(e.pointerId);
    } catch (err) {
      /* plain mouse still works without capture */
    }
    live.addEventListener("pointermove", move);
    live.addEventListener("pointerup", up);
    live.addEventListener("pointercancel", up);
    e.preventDefault();
  }

  _move(e) {
    const d = this._drag;
    if (!d) return;
    const blocks = this._draft[d.id];
    const b = blocks && blocks[d.i];
    if (!b) return;
    const at = this._pos(e, d.track);
    const step = this._config.step;
    const gap = d.gap || { lo: 0, hi: DAY };

    if (Math.abs(at - d.grab) > 4) d.moved = true;

    if (d.mode === "start") {
      b.start = clamp(this._snap(at), gap.lo, b.stop - step);
    } else if (d.mode === "stop") {
      b.stop = clamp(this._snap(at), b.start + step, gap.hi);
    } else {
      const len = d.orig.stop - d.orig.start;
      const s = clamp(this._snap(d.orig.start + (at - d.grab)), gap.lo, gap.hi - len);
      b.start = s;
      b.stop = s + len;
    }
    this._dirty[d.id] = true;
    this._paint(d);
  }

  /** in-place update while dragging — a full re-render would kill the gesture */
  _paint(d) {
    const b = this._draft[d.id][d.i];
    const el = this._card.querySelector(
      '.track[data-sched="' + d.id + '"] .blk[data-i="' + d.i + '"]'
    );
    if (!el || !b) return;
    el.style.left = ((b.start * 100) / DAY).toFixed(3) + "%";
    el.style.width = (((b.stop - b.start) * 100) / DAY).toFixed(3) + "%";
    const lbl = el.querySelector(".lbl");
    if (lbl) lbl.textContent = fmt(b.start) + "–" + fmt(b.stop);
  }

  _up() {
    const d = this._drag;
    this._drag = null;
    if (!d) return;

    if (!d.moved && !d.created) {
      const same = this._edit && this._edit.id === d.id && this._edit.index === d.i;
      this._edit = same ? null : { id: d.id, index: d.i };
    } else {
      const b = this._draft[d.id][d.i];
      const merged = normalise(this._draft[d.id], this._config.step);
      this._draft[d.id] = merged;
      if (d.created && b) {
        const idx = merged.findIndex((x) => x.start === b.start);
        if (idx >= 0) this._edit = { id: d.id, index: idx };
      }
    }
    this._render();
  }
}

/* -------------------------------------------------------------------- css */

const CSS = `
:host { display:block; }
ha-card { overflow:hidden; }
.pad { padding:16px; }
.muted { color:var(--secondary-text-color); font-size:14px; }
.err { color:var(--error-color,#db4437); font-size:14px; }
.hdr { display:flex; align-items:center; gap:8px; padding:13px 16px 4px; }
.hdr-title { font-size:16px; font-weight:600; color:var(--primary-text-color); }
.room { padding:12px 16px 12px; }
.room + .room { border-top:1px solid var(--divider-color,rgba(128,128,128,.2)); }
.room-hd { display:flex; align-items:center; gap:8px; margin-bottom:9px; }
.room-name { font-size:15px; font-weight:600; color:var(--primary-text-color); }
.grow { flex:1; }
.dot { width:8px; height:8px; border-radius:50%; background:rgba(128,128,128,.45); }
.dot.on { background:#F4711C; box-shadow:0 0 0 3px rgba(244,113,28,.18); }
.temp { font-size:15px; font-weight:600; color:var(--primary-text-color); }
.target { font-size:11px; font-weight:600; color:#F4711C; }
.pill { font-size:10.5px; font-weight:600; border-radius:999px; padding:3px 9px; }
.pill.warn { background:rgba(255,193,7,.16); color:#E0A800; }
.pill.ok   { background:rgba(76,175,80,.16); color:#4CAF50; }
.pill.err  { background:rgba(219,68,55,.16); color:#DB4437; }

.mode {
  border:none; cursor:pointer; border-radius:999px; padding:5px 12px;
  font-size:11.5px; font-weight:600;
  background:rgba(128,128,128,.18); color:var(--secondary-text-color);
}
.mode.on { background:rgba(244,113,28,.18); color:#F4711C; }

.row { display:flex; align-items:center; gap:10px; margin-top:7px; }
.row-lbl {
  flex:0 0 62px; text-align:left; font-size:11px; font-weight:600; cursor:pointer;
  color:var(--secondary-text-color); background:none; border:none; padding:4px 2px;
  border-radius:6px;
}
.row-lbl.today { color:var(--primary-text-color); }
.row-lbl.sel { background:rgba(128,128,128,.18); }
.track { position:relative; flex:1; height:30px; border-radius:8px;
         background:rgba(128,128,128,.20); touch-action:none; cursor:copy; }
.blk { position:absolute; top:0; bottom:0; border-radius:7px;
       background:linear-gradient(180deg,#FFB44D,#F4711C);
       display:flex; align-items:center; justify-content:center;
       cursor:grab; overflow:hidden; }
.blk.open { box-shadow:0 0 0 2px var(--primary-text-color); z-index:3; }
.lbl { font-size:10.5px; font-weight:700; color:#43220a; pointer-events:none;
       white-space:nowrap; text-shadow:0 1px 0 rgba(255,255,255,.25); }
.h { position:absolute; top:0; bottom:0; width:14px; cursor:ew-resize; }
.h.left { left:-2px; } .h.right { right:-2px; }
.h::after { content:""; position:absolute; top:9px; bottom:9px; left:6px; width:2px;
            border-radius:2px; background:rgba(67,34,10,.45); }
.now { position:absolute; top:-4px; bottom:-4px; width:2px; margin-left:-1px;
       background:var(--primary-text-color); border-radius:2px; pointer-events:none;
       box-shadow:0 0 0 1.5px var(--ha-card-background,var(--card-background-color,#fff)); }
.scale { display:flex; margin:6px 0 0 72px; }
.scale span { flex:1; font-size:9.5px; color:var(--secondary-text-color); opacity:.75; }
.scale .last { flex:0 0 auto; }

.days { display:flex; align-items:center; gap:5px; margin:8px 0 2px 72px; flex-wrap:wrap; }
.day {
  border:none; cursor:pointer; width:30px; height:26px; border-radius:7px;
  font-size:10.5px; font-weight:700;
  background:rgba(128,128,128,.18); color:var(--secondary-text-color);
}
.day.on { background:rgba(244,113,28,.20); color:#F4711C; }

.editor { margin:9px 0 2px 72px; padding:10px 12px; border-radius:10px;
          background:rgba(128,128,128,.12); }
.ed-row { display:flex; align-items:center; gap:10px; }
.ed-row + .ed-row { margin-top:8px; }
.ed-t { font-size:12px; font-weight:600; color:var(--primary-text-color); }
.big { font-size:17px; font-weight:700; color:var(--primary-text-color);
       min-width:56px; text-align:center; }
.step { width:32px; height:32px; border-radius:8px; border:none; cursor:pointer;
        background:rgba(128,128,128,.22); color:var(--primary-text-color);
        font-size:18px; line-height:1; }
.slider { flex:1; accent-color:#F4711C; }
.actions { display:flex; align-items:center; justify-content:flex-end; gap:8px;
           margin-top:10px; }
.btn { border:none; border-radius:8px; padding:7px 14px; font-size:13px;
       font-weight:600; cursor:pointer; }
.btn.sm { padding:5px 10px; font-size:12px; }
.btn.ghost { background:rgba(128,128,128,.18); color:var(--primary-text-color); }
.btn.primary { background:#F4711C; color:#fff; }
.btn.danger { color:var(--error-color,#db4437); }
.btn[disabled] { opacity:.5; cursor:default; }
`;

/* ------------------------------------------------------------- register */

if (!customElements.get("heat-timeline-card"))
  customElements.define("heat-timeline-card", HeatTimelineCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "heat-timeline-card"))
  window.customCards.push({
    type: "heat-timeline-card",
    name: "Heat Timeline Card",
    description:
      "Wöchentlicher Heizplan als Zeitstrahl — Blöcke ziehen, Tage wählen, Modi schalten.",
    preview: false,
  });

console.info(
  "%c HEAT-TIMELINE-CARD %c " + VERSION + " ",
  "color:#fff;background:#F4711C;font-weight:700",
  "color:#F4711C;background:transparent"
);

// The pure schedule<->blocks helpers are exported so they can be tested
// without a DOM.
export {
  HeatTimelineCard, toBlocks, toTimeslots, normalise, daysLabel, coversToday,
  expandDays, daySortKey, gapAround, withModeConditions,
};
