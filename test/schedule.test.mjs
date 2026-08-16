globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => true, define() {} };
globalThis.window = { customCards: [] };
globalThis.document = { createElement: () => ({ setAttribute(){}, appendChild(){}, style:{} }) };
const M = await import('../dist/heat-timeline-card.js');
let fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : `\n         got ${g}\n         want ${w}`));
};

// Reihenfolge: Montag zuerst
eq('daySortKey Mo-Fr',      M.daySortKey(['mon','tue','wed','thu','fri']), 0);
eq('daySortKey Sa-So',      M.daySortKey(['sat','sun']), 5);
eq('daySortKey workday',    M.daySortKey(['workday']), 0);
eq('daySortKey weekend',    M.daySortKey(['weekend']), 5);
eq('daySortKey nur Mi',     M.daySortKey(['wed']), 2);

// Tokens aufloesen
eq('expandDays daily',      M.expandDays(['daily']), ['mon','tue','wed','thu','fri','sat','sun']);
eq('expandDays workday',    M.expandDays(['workday']), ['mon','tue','wed','thu','fri']);
eq('label einzelne Tage',   M.daysLabel(['mon','wed','fri']), 'Mo, Mi, Fr');
eq('label Mo-Mi',           M.daysLabel(['mon','tue','wed']), 'Mo–Mi');
eq('label taeglich',        M.daysLabel(['daily']), 'Täglich');

// Neuer Block darf Nachbarn nicht verschlucken
const blocks = [{start:360,stop:510,temp:20},{start:960,stop:1350,temp:20}];
eq('Lücke zwischen den Blöcken', M.gapAround(blocks, 700), {lo:510, hi:960});
eq('Lücke vor dem ersten',       M.gapAround(blocks, 100), {lo:0,   hi:360});
eq('Lücke nach dem letzten',     M.gapAround(blocks, 1400),{lo:1350,hi:1440});

// Modus-Bedingungen ergaenzen, vorhandene behalten, nicht doppeln
const modes = {summer:'input_boolean.s', away:'input_boolean.a'};
const c1 = M.withModeConditions([{entity_id:'binary_sensor.w', value:'off', match_type:'is', attribute:null}], modes);
eq('Bedingungen: Anzahl', c1.length, 3);
eq('Bedingungen: null entfernt', Object.keys(c1[0]).includes('attribute'), false);
eq('Bedingungen: nicht doppelt', M.withModeConditions(c1, modes).length, 3);

console.log(fail ? `\n${fail} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden');
process.exit(fail ? 1 : 0);
