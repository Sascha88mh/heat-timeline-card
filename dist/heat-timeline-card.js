/*!
 * Heat Timeline Card for Home Assistant
 * A touch-friendly weekly heating timeline on top of the Scheduler component.
 *
 * No build step, no dependencies — plain ES module + custom element.
 * All markup is built through the DOM, never through string interpolation,
 * so entity names and user config can never inject markup.
 */

const VERSION = "0.1.0";
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

/** Compact label for a set of weekdays: Mo–Fr, Sa–So, Täglich, or Mo, Mi, Fr */
function daysLabel(days) {
  const d = (days || []).map((x) => String(x).toLowerCase());
  if (d.includes("daily") || d.length === 7) return "Täglich";
  if (d.includes("workday")) return "Werktags";
  if (d.includes("weekend")) return "Wochenende";
  const set = new Set(d);
  const idx = WEEK.filter((x) => set.has(x));
  if (idx.length === 5 && !set.has("sat") && !set.has("sun")) return "Mo–Fr";
  if (idx.length === 2 && set.has("sat") && set.has("sun")) return "Sa–So";
  if (idx.length === 0) return "—";
  const pos = idx.map((x) => WEEK.indexOf(x));
  const run = pos.every((p, i) => i === 0 || p === pos[i - 1] + 1);
  if (run && pos.length > 2)
    return WEEK_LABEL[idx[0]] + "–" + WEEK_LABEL[idx[idx.length - 1]];
  return idx.map((x) => WEEK_LABEL[x]).join(", ");
}

/** Does this weekday set cover "today"? */
function coversToday(days) {
  const d = (days || []).map((x) => String(x).toLowerCase());
  const today = WEEK[(new Date().getDay() + 6) % 7];
  const weekend = today === "sat" || today === "sun";
  if (d.includes("daily")) return true;
  if (d.includes("workday")) return !weekend;
  if (d.includes("weekend")) return weekend;
  return d.includes(today);
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
 * Heat blocks -> full-day timeslots, re-using the conditions and action shape
 * of the existing schedule so nothing is silently dropped on save.
 */
function toTimeslots(item, blocks) {
  const first = (item.timeslots || [])[0] || {};
  const entity = scheduleEntity(item);
  const base = {
    conditions: first.conditions || [],
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

/* ------------------------------------------------------------------- card */

class HeatTimelineCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._items = [];   // schedules straight from the scheduler websocket api
    this._draft = {};   // schedule_id -> blocks being edited
    this._dirty = {};   // schedule_id -> true
    this._edit = null;  // {id, index} of the open block editor
    this._loaded = false;
    this._drag = null;
    this._tick = null;
  }

  static getStubConfig() {
    return { title: "Heizung" };
  }

  setConfig(config) {
    this._config = Object.assign(
      {
        title: "Heizung",
        step: 15,
        min_temp: 5,
        max_temp: 30,
        temp_step: 0.5,
        show_now: true,
        entities: null,
      },
      config || {}
    );
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

  _itemById(id) {
    return this._items.find((x) => x.schedule_id === id);
  }

  /** Schedules grouped by the climate entity they control. */
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
          (coversToday(b.weekdays) ? 1 : 0) - (coversToday(a.weekdays) ? 1 : 0)
      );
    return [...map.entries()].map(([entity, schedules]) => ({ entity, schedules }));
  }

  async _save(item) {
    const blocks = normalise(this._blocks(item), this._config.step);
    this._draft[item.schedule_id] = blocks;
    const data = {
      entity_id: item.entity_id,
      weekdays: item.weekdays,
      repeat_type: item.repeat_type || "repeat",
      timeslots: toTimeslots(item, blocks),
    };
    if (item.name) data.name = item.name;
    try {
      await this._hass.callService("scheduler", "edit", data);
      delete this._dirty[item.schedule_id];
      this._flash(item.schedule_id, "ok");
    } catch (e) {
      this._flash(item.schedule_id, "err");
    }
    this._render();
  }

  _revert(item) {
    delete this._draft[item.schedule_id];
    delete this._dirty[item.schedule_id];
    this._edit = null;
    this._render();
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
      if (!rooms.length) {
        kids.push(
          h("div", {
            class: "pad muted",
            text:
              "Keine Heiz-Zeitpläne gefunden. Lege im Scheduler einen Zeitplan " +
              "für ein climate-Gerät an.",
          })
        );
      } else {
        if (this._config.title)
          kids.push(h("div", { class: "hdr", text: this._config.title }));
        for (const r of rooms) kids.push(this._room(r));
      }
    }
    this._card.replaceChildren(...kids);
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

    const actions = dirty
      ? h(
          "div",
          { class: "actions" },
          h("button", {
            class: "btn ghost",
            text: "Verwerfen",
            onclick: () => {
              this._edit = null;
              room.schedules.forEach((s) => this._revert(s));
            },
          }),
          h("button", {
            class: "btn primary",
            text: "Speichern",
            onclick: () => {
              this._edit = null;
              room.schedules.forEach(
                (s) => this._dirty[s.schedule_id] && this._save(s)
              );
            },
          })
        )
      : null;

    return h(
      "div",
      { class: "room" },
      head,
      room.schedules.map((s) => this._row(s)),
      scale,
      actions
    );
  }

  _row(item) {
    const id = item.schedule_id;
    const blocks = normalise(this._blocks(item), this._config.step);
    this._draft[id] = blocks;
    const today = coversToday(item.weekdays);
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
      h("div", {
        class: "row-lbl" + (today ? " today" : ""),
        text: daysLabel(item.weekdays),
      }),
      track
    );

    const ed = this._editor(item, blocks);
    return ed ? h("div", { class: "rowwrap" }, row, ed) : row;
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
          text: "Löschen",
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
      };
    } else {
      // empty track: drop a fresh block and size it by dragging
      const start = this._snap(at);
      const nb = { start, stop: Math.min(start + this._config.step, DAY), temp: 20 };
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

    if (Math.abs(at - d.grab) > 4) d.moved = true;

    if (d.mode === "start") b.start = clamp(this._snap(at), 0, b.stop - step);
    else if (d.mode === "stop") b.stop = clamp(this._snap(at), b.start + step, DAY);
    else {
      const len = d.orig.stop - d.orig.start;
      const s = clamp(this._snap(d.orig.start + (at - d.grab)), 0, DAY - len);
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
.hdr { padding:14px 16px 2px; font-size:16px; font-weight:600;
       color:var(--primary-text-color); }
.room { padding:12px 16px 14px; }
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

.row { display:flex; align-items:center; gap:10px; margin-top:7px; }
.row-lbl { flex:0 0 52px; font-size:11px; font-weight:600;
           color:var(--secondary-text-color); }
.row-lbl.today { color:var(--primary-text-color); }
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
.scale { display:flex; margin:6px 0 0 62px; }
.scale span { flex:1; font-size:9.5px; color:var(--secondary-text-color); opacity:.75; }
.scale .last { flex:0 0 auto; }

.editor { margin:9px 0 2px 62px; padding:10px 12px; border-radius:10px;
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
.actions { display:flex; justify-content:flex-end; gap:8px; margin-top:10px; }
.btn { border:none; border-radius:8px; padding:7px 14px; font-size:13px;
       font-weight:600; cursor:pointer; }
.btn.sm { padding:5px 10px; font-size:12px; }
.btn.ghost { background:rgba(128,128,128,.18); color:var(--primary-text-color); }
.btn.primary { background:#F4711C; color:#fff; }
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
      "Wöchentlicher Heizplan als Zeitstrahl — Blöcke ziehen, Temperatur setzen.",
    preview: false,
  });

console.info(
  "%c HEAT-TIMELINE-CARD %c " + VERSION + " ",
  "color:#fff;background:#F4711C;font-weight:700",
  "color:#F4711C;background:transparent"
);

export { HeatTimelineCard };
