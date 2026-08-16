globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => true, define() {} };
globalThis.window = { customCards: [], localStorage: { getItem:()=>null, setItem(){} } };
globalThis.document = { createElement: () => ({ setAttribute(){}, appendChild(){}, style:{} }) };
const M = await import('../dist/heat-timeline-card.js');
const proto = M.HeatTimelineCard.prototype;
let fail = 0;
const eq = (n,g,w) => { const a=JSON.stringify(g), b=JSON.stringify(w);
  if (a!==b) { fail++; console.log('  FAIL '+n+'\n    got '+a+'\n    want '+b); }
  else console.log('  ok   '+n); };

/**
 * The bug this covers: a room was already heating when an open window got
 * assigned to it. Scheduler conditions only gate a slot as it fires and the
 * open-window automation only triggers on a window opening, so nothing ever
 * switched the room off.
 */
const mk = ({ heat, windowOpen, summer = 'off', away = 'off' }) => {
  const calls = [];
  const self = {
    _hass: {
      states: {
        'climate.wz': { state: heat ? 'heat' : 'off', attributes: {} },
        'binary_sensor.w': { state: windowOpen ? 'on' : 'off', attributes: {} },
        'input_boolean.s': { state: summer, attributes: {} },
        'input_boolean.a': { state: away, attributes: {} },
      },
      callService: async (d, s, data) => calls.push(d + '.' + s + ':' + data.hvac_mode),
    },
    _config: { modes: { summer: 'input_boolean.s', away: 'input_boolean.a' } },
    _windows: () => ['binary_sensor.w'],
    _modeState: proto._modeState,
  };
  return { self, calls };
};
const run = async (opts) => {
  const { self, calls } = mk(opts);
  await proto._enforce.call(self, { entity: 'climate.wz' });
  return calls;
};

eq('heizt + Fenster offen -> abschalten',
   await run({ heat: true,  windowOpen: true  }), ['climate.set_hvac_mode:off']);
eq('heizt + Fenster zu -> nichts tun',
   await run({ heat: true,  windowOpen: false }), []);
eq('aus + Fenster offen -> nichts tun',
   await run({ heat: false, windowOpen: true  }), []);
eq('heizt + Sommermodus an -> abschalten',
   await run({ heat: true,  windowOpen: false, summer: 'on' }), ['climate.set_hvac_mode:off']);
eq('heizt + Unterwegs an -> abschalten',
   await run({ heat: true,  windowOpen: false, away: 'on' }),   ['climate.set_hvac_mode:off']);

console.log(fail ? `\n${fail} fehlgeschlagen` : '\nAlle Tests bestanden');
process.exit(fail?1:0);
