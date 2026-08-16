globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => true, define() {} };
globalThis.window = { customCards: [] };
globalThis.document = { createElement: () => ({ setAttribute(){}, appendChild(){}, style:{} }) };
const M = await import('../dist/heat-timeline-card.js');
let fail = 0;
const eq = (n,g,w) => { const a=JSON.stringify(g), b=JSON.stringify(w);
  if (a!==b) { fail++; console.log('  FAIL '+n+'\n    got '+a+'\n    want '+b); }
  else console.log('  ok   '+n); };

const conds = [
  {entity_id:'input_boolean.sommermodus', value:'off', match_type:'is'},
  {entity_id:'input_boolean.unterwegs',   value:'off', match_type:'is'},
  {entity_id:'binary_sensor.kueche_dachfenster', value:'off', match_type:'is'},
];
eq('Fenster erkannt', conds.filter(M.isWindowCond).map(c=>c.entity_id),
   ['binary_sensor.kueche_dachfenster']);
eq('windowsOf', M.windowsOf({timeslots:[{conditions:conds}]}),
   ['binary_sensor.kueche_dachfenster']);

const replaced = M.setWindows(conds, ['binary_sensor.a','binary_sensor.b']);
eq('Modi bleiben', replaced.filter(c=>!M.isWindowCond(c)).map(c=>c.entity_id),
   ['input_boolean.sommermodus','input_boolean.unterwegs']);
eq('neue Fenster', replaced.filter(M.isWindowCond).map(c=>c.entity_id),
   ['binary_sensor.a','binary_sensor.b']);
eq('alle Fenster entfernbar', M.setWindows(conds, []).length, 2);
eq('null wird entfernt',
   M.setWindows([{entity_id:'binary_sensor.x',value:'off',match_type:'is',attribute:null}],[])
     .length, 0);

// toTimeslots mit ausdruecklichen Bedingungen
const item = {timeslots:[{start:'00:00:00',stop:'00:00:00',conditions:conds,
  condition_type:'and',track_conditions:true,
  actions:[{entity_id:'climate.x',service:'climate.set_hvac_mode',service_data:{hvac_mode:'off'}}]}]};
const slots = M.toTimeslots(item, [{start:360,stop:480,temp:21}],
  {summer:'input_boolean.sommermodus', away:'input_boolean.unterwegs'},
  M.setWindows(conds, ['binary_sensor.neu']));
eq('Bedingungen im Ergebnis',
   slots[0].conditions.map(c=>c.entity_id),
   ['input_boolean.sommermodus','input_boolean.unterwegs','binary_sensor.neu']);
eq('Tag lückenlos', slots.map(s=>s.start.slice(0,5)+'-'+s.stop.slice(0,5)),
   ['00:00-06:00','06:00-08:00','08:00-00:00']);

console.log(fail ? `\n${fail} fehlgeschlagen` : '\nAlle Tests bestanden');
process.exit(fail?1:0);
