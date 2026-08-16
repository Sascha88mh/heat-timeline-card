/*!
 * Heat Timeline Card for Home Assistant
 * A touch-friendly weekly heating timeline on top of the Scheduler component.
 *
 * No build step, no dependencies — plain ES module + custom element.
 * All markup is built through the DOM, never through string interpolation,
 * so entity names and user config can never inject markup.
 */

const VERSION = "0.6.0";
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

/** Window/door sensors act as conditions; the mode helpers are not windows. */
const isWindowCond = (c) =>
  String(c.entity_id || "").slice(0, "binary_sensor.".length) === "binary_sensor.";

/** Window sensors currently guarding a schedule. */
function windowsOf(item) {
  const first = (item.timeslots || [])[0] || {};
  return (first.conditions || []).filter(isWindowCond).map((c) => c.entity_id);
}

/** Replace the window part of a condition list, keeping everything else. */
function setWindows(conditions, sensors) {
  const kept = cleanConditions(conditions).filter((c) => !isWindowCond(c));
  return kept.concat(
    sensors.map((e) => ({ entity_id: e, value: "off", match_type: "is" }))
  );
}

const WINDOW_CLASSES = ["window", "door", "opening", "garage_door"];
const ORDER_KEY = "heat-timeline-card:order";

/**
 * Heat blocks -> full-day timeslots, re-using the conditions and action shape
 * of the existing schedule so nothing is silently dropped on save.
 */
function toTimeslots(item, blocks, modes, conditions, target) {
  const first = (item.timeslots || [])[0] || {};
  const entity = target || scheduleEntity(item);
  const base = {
    conditions: withModeConditions(
      conditions === undefined ? first.conditions : conditions,
      modes || {}
    ),
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
    this._conds = {};   // schedule_id -> conditions being edited
    this._dirty = {};   // schedule_id -> true
    this._edit = null;  // {id, index} of the open block editor
    this._open = {};    // schedule_id -> day/settings strip expanded
    this._gear = {};    // climate entity -> settings panel expanded
    this._target = {};  // schedule_id -> climate entity being reassigned
    this._pick = {};    // picker key -> selected value, kept across renders
    this._nameDraft = {}; // climate entity -> name being typed
    this._addOpen = false; // "add a room" form revealed
    this._sig = "";
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
    if (first) {
      this._load();
      return;
    }
    if (!this._loaded || this._drag) return;
    // Home Assistant pushes every state change in the house — in a busy home
    // that is dozens per minute. Re-rendering each time would throw away the
    // open picker and any half-finished interaction, so only redraw when
    // something this card actually shows has moved.
    const sig = this._signature();
    if (sig === this._sig) return;
    this._render();
  }

  /** Fingerprint of everything the card displays. */
  _signature() {
    if (!this._hass || !this._config) return "";
    const parts = [Object.keys(this._hass.states).length];
    const push = (id) => {
      const st = id && this._hass.states[id];
      parts.push(
        id +
          "=" +
          (st
            ? st.state +
              "/" +
              st.attributes.current_temperature +
              "/" +
              st.attributes.temperature +
              "/" +
              st.attributes.friendly_name
            : "-")
      );
    };
    for (const room of this._rooms()) {
      push(room.entity);
      for (const w of this._windows(room)) push(w);
      parts.push(this._ruleEntity(room) ? "rule" : "norule");
    }
    push(this._config.modes.summer);
    push(this._config.modes.away);
    return parts.join(",");
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
      this._conds = {};
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

  _conditions(item) {
    if (!this._conds[item.schedule_id])
      this._conds[item.schedule_id] = cleanConditions(
        ((item.timeslots || [])[0] || {}).conditions
      );
    return this._conds[item.schedule_id];
  }

  /* ---------------------------------------------------------- windows */

  /** Window sensors guarding a room (union over its schedules). */
  _windows(room) {
    const set = new Set();
    for (const s of room.schedules)
      for (const c of this._conditions(s)) if (isWindowCond(c)) set.add(c.entity_id);
    return [...set];
  }

  /** Assign the window list to every schedule of the room. */
  _setRoomWindows(room, sensors) {
    for (const s of room.schedules) {
      this._conds[s.schedule_id] = setWindows(this._conditions(s), sensors);
      this._dirty[s.schedule_id] = true;
    }
    this._render();
  }

  _areaOf(entityId) {
    const hass = this._hass;
    const ent = hass.entities && hass.entities[entityId];
    if (!ent) return null;
    if (ent.area_id) return ent.area_id;
    const dev = ent.device_id && hass.devices && hass.devices[ent.device_id];
    return dev ? dev.area_id || null : null;
  }

  _areaName(areaId) {
    const a = areaId && this._hass.areas && this._hass.areas[areaId];
    return a ? a.name : null;
  }

  /** Openable sensors, the ones sharing the room's area first. */
  _windowCandidates(room) {
    const taken = new Set(this._windows(room));
    const roomArea = this._areaOf(room.entity);
    const out = [];
    for (const id of Object.keys(this._hass.states)) {
      if (id.slice(0, 14) !== "binary_sensor.") continue;
      if (taken.has(id)) continue;
      const st = this._hass.states[id];
      if (WINDOW_CLASSES.indexOf(st.attributes.device_class) === -1) continue;
      const area = this._areaOf(id);
      out.push({
        id,
        name: st.attributes.friendly_name || id,
        area: this._areaName(area),
        same: !!roomArea && area === roomArea,
      });
    }
    out.sort(
      (a, b) => (b.same ? 1 : 0) - (a.same ? 1 : 0) || a.name.localeCompare(b.name)
    );
    return out;
  }

  /* ------------------------------------- "switch off when opened" rule */

  _ruleIdFor(entity) {
    return "heat_timeline_" + String(entity).replace(/[^a-z0-9]+/gi, "_");
  }

  _ruleEntityFor(entity) {
    const id = this._ruleIdFor(entity);
    for (const eid of Object.keys(this._hass.states)) {
      if (eid.slice(0, 11) !== "automation.") continue;
      if (this._hass.states[eid].attributes.id === id) return eid;
    }
    return null;
  }

  _ruleEntity(room) {
    return this._ruleEntityFor(room.entity);
  }

  async _writeRule(entity, sensors) {
    const id = this._ruleIdFor(entity);
    if (!sensors.length) return this._deleteRule(entity);
    const st = this._hass.states[entity];
    const name = (st && st.attributes.friendly_name) || String(entity).split(".")[1];
    await this._hass.callApi("post", "config/automation/config/" + id, {
      id: id,
      alias: name + ": Heizung aus bei offenem Fenster",
      description: "Angelegt von der Heat Timeline Card.",
      triggers: [{ trigger: "state", entity_id: sensors, from: "off", to: "on" }],
      conditions: [],
      actions: [
        {
          action: "climate.set_hvac_mode",
          target: { entity_id: entity },
          data: { hvac_mode: "off" },
        },
      ],
      mode: "single",
    });
  }

  async _deleteRule(entity) {
    await this._hass.callApi(
      "delete",
      "config/automation/config/" + this._ruleIdFor(entity)
    );
  }

  /**
   * Scheduler conditions keep a room from *starting* to heat, but they never
   * stop heat that is already running. That needs an automation, which the
   * frontend can write through the config API.
   */
  async _toggleRule(room) {
    if (this._busy) return;
    this._busy = true;
    this._render();
    try {
      if (this._ruleEntity(room)) {
        await this._deleteRule(room.entity);
        await this._hass.callService("automation", "reload", {});
      } else {
        await this._writeRule(room.entity, this._windows(room));
        await this._hass.callService("automation", "reload", {});
        // a window that is already open must take effect straight away
        await this._enforce(room);
      }
    } catch (e) {
      this._error = "Die Regel konnte nicht gespeichert werden: " + e.message;
    }
    this._busy = false;
    this._render();
  }

  /** Keep an existing rule's trigger list in step with the window list. */
  async _syncRule(room) {
    if (!this._ruleEntity(room)) return;
    try {
      await this._writeRule(room.entity, this._windows(room));
      await this._hass.callService("automation", "reload", {});
    } catch (e) {
      /* the schedules were saved; the rule stays as it was */
    }
  }

  /**
   * Apply the guards to the here and now.
   *
   * Scheduler conditions only gate a slot as it fires, and the open-window rule
   * only triggers on a window *opening*. Assign an already-open window to a room
   * that is currently heating and neither of them would ever act — the room
   * would stay warm with the window open until the next slot boundary. So after
   * any change, check the guards once and switch the room off if they say so.
   */
  async _enforce(room) {
    const st = this._hass.states[room.entity];
    if (!st || st.state !== "heat") return;
    const blocked =
      this._windows(room).some(
        (w) => this._hass.states[w] && this._hass.states[w].state === "on"
      ) ||
      this._modeState("summer") === true ||
      this._modeState("away") === true;
    if (!blocked) return;
    try {
      await this._hass.callService("climate", "set_hvac_mode", {
        entity_id: room.entity,
        hvac_mode: "off",
      });
    } catch (e) {
      /* nothing to recover — the next slot will set it straight */
    }
  }

  _itemById(id) {
    return this._items.find((x) => x.schedule_id === id);
  }

  /** User-chosen room order: config wins, otherwise what the buttons stored. */
  _order() {
    if (Array.isArray(this._config.order)) return this._config.order;
    try {
      const raw = window.localStorage.getItem(ORDER_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  _saveOrder(list) {
    try {
      window.localStorage.setItem(ORDER_KEY, JSON.stringify(list));
    } catch (e) {
      /* private mode or storage full — ordering just won't persist */
    }
    this._render();
  }

  _moveRoom(entity, delta) {
    const cur = this._rooms().map((r) => r.entity);
    const i = cur.indexOf(entity);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= cur.length) return;
    cur.splice(j, 0, cur.splice(i, 1)[0]);
    this._saveOrder(cur);
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

    const order = this._order();
    const rank = (e) => {
      const i = order.indexOf(e);
      return i === -1 ? order.length + 1 : i;
    };
    return [...map.entries()]
      .map(([entity, schedules]) => ({ entity, schedules }))
      .sort(
        (a, b) =>
          rank(a.entity) - rank(b.entity) ||
          this._roomName(a.entity).localeCompare(this._roomName(b.entity))
      );
  }

  _roomName(entity) {
    const st = this._hass && this._hass.states[entity];
    return (st && st.attributes.friendly_name) || String(entity).split(".")[1];
  }

  /**
   * Renaming the thermostat is how a room gets its name.
   *
   * The typed text lives in component state, because a redraw would otherwise
   * rebuild the input from the entity and snap it back to the old name before
   * the registry has even answered.
   */
  async _rename(room) {
    const key = room.entity;
    const next = String(this._nameDraft[key] || "").trim();
    if (!next || next === this._roomName(key)) {
      delete this._nameDraft[key];
      this._render();
      return;
    }
    this._busy = true;
    try {
      await this._hass.connection.sendMessagePromise({
        type: "config/entity_registry/update",
        entity_id: key,
        name: next,
      });
      delete this._nameDraft[key];
    } catch (e) {
      this._error = "Umbenennen fehlgeschlagen: " + e.message;
    }
    this._busy = false;
    this._render();
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
      timeslots: toTimeslots(
        item,
        blocks,
        this._config.modes,
        this._conditions(item),
        this._target[item.schedule_id]
      ),
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
    delete this._conds[item.schedule_id];
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
              "Noch kein Heizplan vorhanden. Wähle unten ein Thermostat aus — " +
              "alles Weitere stellst du danach hier ein.",
          })
        );
      else for (const r of rooms) kids.push(this._room(r));
      kids.push(
        h(
          "div",
          { class: "room addroom" },
          h(
            "div",
            { class: "addbar" },
            h("button", {
              class: "btn ghost sm" + (this._addOpen ? " on" : ""),
              text: this._addOpen ? "Abbrechen" : "+ Hinzufügen",
              onclick: () => {
                this._addOpen = !this._addOpen;
                this._render();
              },
            })
          ),
          this._addOpen || !rooms.length ? this._addRoomPanel() : null
        )
      );
    }
    this._card.replaceChildren(...kids);
    this._sig = this._signature();
  }

  /**
   * A <select> loses its value whenever the card redraws. Keeping the choice in
   * component state and restoring it makes the pickers survive a re-render.
   */
  _select(key, options, placeholder) {
    const el = h(
      "select",
      {
        class: "picker",
        onchange: (e) => {
          this._pick[key] = e.target.value;
        },
      },
      h("option", { value: "", text: placeholder }),
      options.map((o) => h("option", { value: o.id, text: o.label }))
    );
    const want = this._pick[key];
    if (want && options.some((o) => o.id === want)) el.value = want;
    else this._pick[key] = "";
    return el;
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
        : null,
      h("button", {
        class: "gear" + (this._gear[room.entity] ? " on" : ""),
        text: "⚙",
        title: "Einstellungen",
        onclick: () => {
          this._gear[room.entity] = !this._gear[room.entity];
          this._render();
        },
      })
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
            onclick: async () => {
              this._edit = null;
              for (const s of room.schedules)
                if (this._dirty[s.schedule_id]) await this._save(s);
              // an existing "switch off when opened" rule follows the window list
              await this._syncRule(room);
              await this._enforce(room);
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
      dirty ? foot : null,
      this._gear[room.entity] ? this._roomSettings(room) : null
    );
  }

  /** Everything configurable about a room, tucked behind the gear. */
  _roomSettings(room) {
    const used = new Set(this._rooms().map((r) => r.entity));
    const options = Object.keys(this._hass.states)
      .filter((id) => id.slice(0, 8) === "climate.")
      .filter((id) => id === room.entity || !used.has(id))
      .map((id) => ({
        id,
        label:
          (this._hass.states[id].attributes.friendly_name || id) +
          (id === room.entity ? "  (aktuell)" : ""),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const picker = this._select(
      "room:" + room.entity,
      options,
      "Thermostat wählen…"
    );

    const key = room.entity;
    const pending = this._nameDraft[key] !== undefined;
    const nameInput = h("input", {
      class: "text",
      type: "text",
      value: pending ? this._nameDraft[key] : this._roomName(key),
      placeholder: "Name des Raums",
      oninput: (e) => {
        this._nameDraft[key] = e.target.value;
        const btn = this._card.querySelector('.save-name[data-room="' + key + '"]');
        if (btn) btn.disabled = !String(e.target.value).trim();
      },
      onkeydown: (e) => {
        if (e.key === "Enter") this._rename(room);
      },
    });

    const rooms = this._rooms().map((r) => r.entity);
    const pos = rooms.indexOf(room.entity);

    return h(
      "div",
      { class: "wpanel" },

      h("div", { class: "wtitle", text: "Name" }),
      h(
        "div",
        { class: "wrow" },
        nameInput,
        (() => {
          const b = h("button", {
            class: "btn primary sm save-name",
            "data-room": key,
            text: "Speichern",
            onclick: () => this._rename(room),
          });
          b.disabled = this._busy || !String(nameInput.value).trim();
          return b;
        })(),
        h("button", {
          class: "arrow",
          text: "↑",
          title: "Nach oben",
          disabled: pos <= 0 ? "true" : null,
          onclick: () => this._moveRoom(room.entity, -1),
        }),
        h("button", {
          class: "arrow",
          text: "↓",
          title: "Nach unten",
          disabled: pos < 0 || pos >= rooms.length - 1 ? "true" : null,
          onclick: () => this._moveRoom(room.entity, 1),
        })
      ),
      h("div", {
        class: "muted sm",
        text:
          "Wird sofort übernommen. Der Name ist der des Thermostats und gilt " +
          "in ganz Home Assistant. Mit den Pfeilen sortierst du die Räume hier.",
      }),

      h("div", { class: "wtitle", text: "Fenster in diesem Raum" }),
      this._windowSection(room),

      h("div", { class: "wtitle", text: "Zeitpläne und Gerät" }),
      h(
        "div",
        { class: "wrow" },
        picker,
        h("button", {
          class: "btn ghost sm",
          text: "Thermostat übernehmen",
          disabled: this._busy ? "true" : null,
          onclick: () => {
            const next = this._pick["room:" + room.entity];
            if (!next || next === room.entity) return;
            this._retargetRoom(room, next);
          },
        })
      ),
      h(
        "div",
        { class: "wrow" },
        h("button", {
          class: "btn ghost sm",
          text: "+ Zeitplan",
          disabled: this._busy ? "true" : null,
          onclick: () => this._addSchedule(room),
        }),
        h("button", {
          class: "btn ghost sm danger",
          text: "Raum entfernen",
          disabled: this._busy ? "true" : null,
          onclick: () => this._removeRoom(room),
        }),
        h("span", {
          class: "muted sm",
          text: "entfernt " + room.schedules.length + " Zeitpläne",
        })
      )
    );
  }

  async _retargetRoom(room, next) {
    if (this._busy) return;
    this._busy = true;
    this._render();
    const sensors = this._windows(room);
    const hadRule = !!this._ruleEntity(room);
    try {
      for (const s of room.schedules) {
        this._target[s.schedule_id] = next;
        await this._save(s, true);
      }
      if (hadRule) {
        // the rule is keyed by thermostat, so move it across
        await this._deleteRule(room.entity);
        await this._writeRule(next, sensors);
        await this._hass.callService("automation", "reload", {});
      }
    } catch (e) {
      this._error = "Der Raum konnte nicht umgestellt werden: " + e.message;
    }
    this._target = {};
    this._pick = {};
    this._addOpen = false;
    this._busy = false;
    await this._reload();
  }

  async _removeRoom(room) {
    if (this._busy) return;
    this._busy = true;
    this._render();
    try {
      if (this._ruleEntity(room)) {
        await this._deleteRule(room.entity);
        await this._hass.callService("automation", "reload", {});
      }
      for (const s of room.schedules)
        await this._hass.callService("scheduler", "remove", {
          entity_id: s.entity_id,
        });
    } catch (e) {
      this._error = "Der Raum konnte nicht entfernt werden: " + e.message;
    }
    delete this._gear[room.entity];
    this._busy = false;
    await this._reload();
  }

  /** Assign window sensors to a room and decide what an open window does. */
  _windowSection(room) {
    const sensors = this._windows(room);
    const cand = this._windowCandidates(room);
    const ruleOn = !!this._ruleEntity(room);

    const chips = sensors.length
      ? sensors.map((id) => {
          const st = this._hass.states[id];
          const open = st && st.state === "on";
          return h(
            "span",
            { class: "wchip" + (open ? " open" : "") },
            h("span", { text: (st && st.attributes.friendly_name) || id }),
            h("button", {
              class: "x",
              text: "✕",
              title: "Entfernen",
              onclick: () => {
                this._setRoomWindows(room, sensors.filter((s) => s !== id));
              },
            })
          );
        })
      : [h("span", { class: "muted sm", text: "Noch kein Fenster zugeordnet." })];

    const picker = this._select(
      "win:" + room.entity,
      cand.map((c) => ({
        id: c.id,
        label: c.name + (c.area ? " · " + c.area : "") + (c.same ? "  ✓" : ""),
      })),
      cand.length ? "Fenster wählen…" : "Keine weiteren Sensoren"
    );

    return h(
      "div",
      { class: "wsection" },
      h("div", { class: "wchips" }, chips),
      h(
        "div",
        { class: "wrow" },
        picker,
        h("button", {
          class: "btn ghost sm",
          text: "Hinzufügen",
          disabled: cand.length ? null : "true",
          onclick: () => {
            const sel = this._pick["win:" + room.entity];
            if (!sel) return;
            this._pick["win:" + room.entity] = "";
            this._setRoomWindows(room, sensors.concat([sel]));
          },
        })
      ),
      h("div", {
        class: "muted sm",
        text:
          "Solange eines dieser Fenster offen ist, startet kein Zeitplan die " +
          "Heizung. Schließt es wieder, heizt der laufende Block sofort weiter.",
      }),
      h(
        "div",
        { class: "wrow" },
        h("button", {
          class: "toggle" + (ruleOn ? " on" : ""),
          text: ruleOn ? "Ein" : "Aus",
          disabled: this._busy || !sensors.length ? "true" : null,
          onclick: () => this._toggleRule(room),
        }),
        h("span", {
          class: "sm",
          text: "Laufende Heizung sofort abschalten, wenn ein Fenster geöffnet wird",
        })
      ),
      ruleOn
        ? h("div", {
            class: "muted sm",
            text: "Dafür liegt eine Automation in Home Assistant, die diese Karte verwaltet.",
          })
        : null
    );
  }

  /** First-run path: pick a thermostat and get a working week straight away. */
  _addRoomPanel() {
    const used = new Set(this._rooms().map((r) => r.entity));
    const cand = Object.keys(this._hass.states)
      .filter((id) => id.slice(0, 8) === "climate." && !used.has(id))
      .map((id) => ({
        id,
        name: this._hass.states[id].attributes.friendly_name || id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const picker = this._select(
      "newroom",
      cand.map((c) => ({ id: c.id, label: c.name })),
      cand.length ? "Thermostat wählen…" : "Kein weiteres Thermostat"
    );

    return h(
      "div",
      { class: "wpanel" },
      h("div", { class: "wtitle", text: "Raum hinzufügen" }),
      h(
        "div",
        { class: "wrow" },
        picker,
        h("button", {
          class: "btn primary sm",
          text: "Anlegen",
          disabled: this._busy || !cand.length ? "true" : null,
          onclick: () => {
            const sel = this._pick.newroom;
            if (!sel) return;
            this._pick.newroom = "";
            this._addRoom(sel);
          },
        })
      ),
      h("div", {
        class: "muted sm",
        text:
          "Legt zwei Zeitpläne an — Mo–Fr und Sa–So, jeweils 06:00–22:00 bei 20 °. " +
          "Zeiten, Tage und Fenster stellst du danach direkt hier ein.",
      })
    );
  }

  async _addRoom(entity) {
    if (this._busy) return;
    this._busy = true;
    this._render();
    const st = this._hass.states[entity];
    const name = (st && st.attributes.friendly_name) || entity.split(".")[1];
    const conditions = withModeConditions([], this._config.modes);
    const base = { conditions, condition_type: "and", track_conditions: true };
    const mk = (start, stop, temp) =>
      Object.assign({ start: toTime(start), stop: toTime(stop) }, base, {
        actions: [
          temp === null
            ? {
                entity_id: entity,
                service: "climate.set_hvac_mode",
                service_data: { hvac_mode: "off" },
              }
            : {
                entity_id: entity,
                service: "climate.set_temperature",
                service_data: { temperature: temp, hvac_mode: "heat" },
              },
        ],
      });
    const slots = [mk(0, 360, null), mk(360, 1320, 20), mk(1320, DAY, null)];
    try {
      for (const [label, days] of [
        ["Mo–Fr", ["mon", "tue", "wed", "thu", "fri"]],
        ["Sa–So", ["sat", "sun"]],
      ])
        await this._hass.callService("scheduler", "add", {
          name: name + " " + label,
          weekdays: days,
          repeat_type: "repeat",
          timeslots: slots,
        });
    } catch (e) {
      this._error = "Der Raum konnte nicht angelegt werden: " + e.message;
    }
    this._busy = false;
    await this._reload();
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
.btn.on { background:rgba(244,113,28,.20); color:#F4711C; }
.btn[disabled] { opacity:.5; cursor:default; }

.sm { font-size:11.5px; color:var(--primary-text-color); }
.muted.sm { color:var(--secondary-text-color); line-height:1.45; }
.wpanel { margin-top:10px; padding:12px; border-radius:12px;
          background:rgba(128,128,128,.12); display:flex; flex-direction:column; gap:9px; }
.wtitle { font-size:12px; font-weight:700; color:var(--primary-text-color);
          letter-spacing:.2px; }
.wchips { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.wchip { display:inline-flex; align-items:center; gap:6px; border-radius:999px;
         padding:4px 6px 4px 11px; font-size:11.5px; font-weight:600;
         background:rgba(128,128,128,.22); color:var(--primary-text-color); }
.wchip.open { background:rgba(94,190,255,.18); color:#5EBEFF; }
.wchip .x { border:none; background:none; cursor:pointer; font-size:11px;
            line-height:1; padding:2px 4px; color:inherit; opacity:.7; }
.wchip .x:hover { opacity:1; }
.wrow { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.picker { flex:1; min-width:150px; border-radius:8px; padding:7px 9px;
          font-size:12.5px; border:1px solid var(--divider-color,rgba(128,128,128,.3));
          background:var(--card-background-color,transparent);
          color:var(--primary-text-color); }
.toggle { border:none; cursor:pointer; border-radius:999px; padding:5px 14px;
          font-size:11.5px; font-weight:700; min-width:52px;
          background:rgba(128,128,128,.22); color:var(--secondary-text-color); }
.toggle.on { background:rgba(244,113,28,.20); color:#F4711C; }
.toggle[disabled] { opacity:.5; cursor:default; }
.addroom { padding-top:10px; }
.addbar { display:flex; justify-content:flex-end; }
.addbar + .wpanel { margin-top:10px; }
.gear { border:none; background:none; cursor:pointer; font-size:15px; line-height:1;
        padding:3px 5px; border-radius:8px; color:var(--secondary-text-color); }
.gear:hover { color:var(--primary-text-color); }
.gear.on { background:rgba(244,113,28,.20); color:#F4711C; }
.wsection { display:flex; flex-direction:column; gap:9px; }
.text { flex:1; min-width:130px; border-radius:8px; padding:7px 9px; font-size:12.5px;
        border:1px solid var(--divider-color,rgba(128,128,128,.3));
        background:var(--card-background-color,transparent);
        color:var(--primary-text-color); }
.arrow { border:none; cursor:pointer; width:30px; height:30px; border-radius:8px;
         background:rgba(128,128,128,.22); color:var(--primary-text-color);
         font-size:13px; line-height:1; }
.arrow[disabled] { opacity:.35; cursor:default; }
.wpanel .wtitle + .wtitle { margin-top:2px; }
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
  windowsOf, setWindows, isWindowCond,
};
