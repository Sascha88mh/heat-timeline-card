globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => true, define() {} };
globalThis.window = { customCards: [] };
globalThis.document = { createElement: () => ({ setAttribute(){}, appendChild(){}, style:{} }) };
const M = await import('../dist/heat-timeline-card.js');
let fail = 0;
const eq = (n,g,w) => { const a=JSON.stringify(g), b=JSON.stringify(w);
  if (a!==b) { fail++; console.log('  FAIL '+n+'\n    got '+a+'\n    want '+b); }
  else console.log('  ok   '+n); };

/* --- Thermostat des Raums wechseln --- */
const conds=[{entity_id:'binary_sensor.w',value:'off',match_type:'is'}];
const item={timeslots:[{start:'00:00:00',stop:'00:00:00',conditions:conds,condition_type:'and',
  track_conditions:true,actions:[{entity_id:'climate.alt',service:'climate.set_hvac_mode',
  service_data:{hvac_mode:'off'}}]}]};
const blocks=[{start:360,stop:480,temp:21}];
const ohne = M.toTimeslots(item, blocks, {}, undefined, undefined);
eq('ohne Wechsel bleibt altes Gerät', [...new Set(ohne.map(s=>s.actions[0].entity_id))], ['climate.alt']);
const mit = M.toTimeslots(item, blocks, {}, undefined, 'climate.neu');
eq('mit Wechsel überall neues Gerät', [...new Set(mit.map(s=>s.actions[0].entity_id))], ['climate.neu']);
eq('Bedingungen überleben den Wechsel', mit[0].conditions.map(c=>c.entity_id), ['binary_sensor.w']);
eq('Heizblock behält Temperatur',
   mit.filter(s=>s.actions[0].service==='climate.set_temperature')
      .map(s=>s.actions[0].service_data.temperature), [21]);

/* --- Render-Bremse: Signatur --- */
const proto = M.HeatTimelineCard.prototype;
const mkFake = (states) => ({
  _hass: { states },
  _config: { modes: { summer:'input_boolean.s', away:'input_boolean.a' } },
  _rooms: () => [{ entity:'climate.wz', schedules:[] }],
  _windows: () => ['binary_sensor.w'],
  _ruleEntity: () => null,
});
const base = {
  'climate.wz': {state:'off', attributes:{current_temperature:21, temperature:20}},
  'binary_sensor.w': {state:'off', attributes:{}},
  'input_boolean.s': {state:'off', attributes:{}},
  'input_boolean.a': {state:'off', attributes:{}},
  'light.irgendwo': {state:'on', attributes:{}},
};
const sig = (s) => proto._signature.call(mkFake(s));
const s0 = sig(base);

const unrelated = {...base, 'light.irgendwo': {state:'off', attributes:{}}};
eq('fremde Entität ändert nichts', sig(unrelated) === s0, true);

const relevantTemp = {...base, 'climate.wz': {state:'off', attributes:{current_temperature:22, temperature:20}}};
eq('Raumtemperatur löst Rendern aus', sig(relevantTemp) !== s0, true);

const windowOpen = {...base, 'binary_sensor.w': {state:'on', attributes:{}}};
eq('Fenster löst Rendern aus', sig(windowOpen) !== s0, true);

const modeOn = {...base, 'input_boolean.s': {state:'on', attributes:{}}};
eq('Modus löst Rendern aus', sig(modeOn) !== s0, true);

const added = {...base, 'binary_sensor.ganz_neu': {state:'off', attributes:{device_class:'window'}}};
eq('NEUE Entität löst Rendern aus', sig(added) !== s0, true);

console.log(fail ? `\n${fail} fehlgeschlagen` : '\nAlle Tests bestanden');
process.exit(fail?1:0);
