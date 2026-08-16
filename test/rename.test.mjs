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

const mk = (draft, current, shouldThrow) => {
  const sent = [];
  const self = {
    _nameDraft: draft === undefined ? {} : { 'climate.wz': draft },
    _busy: false,
    _renders: 0,
    _card: { querySelector: () => null },
    _hass: {
      states: { 'climate.wz': { state:'off', attributes:{ friendly_name: current } } },
      connection: { sendMessagePromise: async (m) => {
        if (shouldThrow) throw new Error('nope');
        sent.push(m); return {};
      } },
    },
    _roomName: proto._roomName,
    _render() { this._renders++; },
  };
  return { self, sent };
};

let { self, sent } = mk('Bad', 'Badezimmer Thermostat');
await proto._rename.call(self, { entity: 'climate.wz' });
eq('sendet den neuen Namen', sent.map(m => [m.type, m.entity_id, m.name]),
   [['config/entity_registry/update','climate.wz','Bad']]);
eq('Entwurf wird nach Erfolg verworfen', self._nameDraft, {});
eq('busy wieder false', self._busy, false);

({ self, sent } = mk('  Badezimmer Thermostat  ', 'Badezimmer Thermostat'));
await proto._rename.call(self, { entity: 'climate.wz' });
eq('gleicher Name -> kein Aufruf', sent.length, 0);

({ self, sent } = mk('   ', 'Badezimmer Thermostat'));
await proto._rename.call(self, { entity: 'climate.wz' });
eq('leerer Name -> kein Aufruf', sent.length, 0);

({ self, sent } = mk('Neu', 'Alt', true));
await proto._rename.call(self, { entity: 'climate.wz' });
eq('Fehler -> Entwurf bleibt erhalten', self._nameDraft, { 'climate.wz': 'Neu' });
eq('Fehler -> Meldung gesetzt', /Umbenennen fehlgeschlagen/.test(self._error||''), true);

/* Signatur muss auf den Namen reagieren, sonst erscheint er nie */
const fake = (name) => ({
  _hass: { states: {
    'climate.wz': { state:'off', attributes:{ current_temperature:21, temperature:20, friendly_name:name } },
    'input_boolean.s': { state:'off', attributes:{} },
    'input_boolean.a': { state:'off', attributes:{} } } },
  _config: { modes: { summer:'input_boolean.s', away:'input_boolean.a' } },
  _rooms: () => [{ entity:'climate.wz', schedules:[] }],
  _windows: () => [],
  _ruleEntity: () => null,
});
eq('Namensänderung löst Rendern aus',
   proto._signature.call(fake('Alt')) !== proto._signature.call(fake('Neu')), true);

console.log(fail ? `\n${fail} fehlgeschlagen` : '\nAlle Tests bestanden');
process.exit(fail?1:0);
