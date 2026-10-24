const assert = require('assert');
const {
  getAreaFromMap,
  getLocalityName,
  resolveAreaCandidates,
} = require('../src/scripts/import/areaResolution');

const existingArea = {
  _id: 'existing-andheri-area',
  name: 'Andheri Eastern Suburb',
  slug: 'andheri-east',
};

const resolution = resolveAreaCandidates(
  [existingArea],
  ['Andheri-East', '  ANDHERI east  ', 'New Locality'],
  name => ({ _id: `new-${name}`, name, slug: name.toLowerCase().replace(/\s+/g, '-') })
);

assert.strictEqual(resolution.areasToCreate.length, 1);
assert.strictEqual(resolution.areasToCreate[0].name, 'New Locality');
assert.strictEqual(getAreaFromMap(resolution.areaMap, 'Andheri-East'), existingArea);
assert.strictEqual(getAreaFromMap(resolution.areaMap, '  ANDHERI east  '), existingArea);
assert.strictEqual(getAreaFromMap(resolution.areaMap, 'New Locality'), resolution.areasToCreate[0]);
assert.strictEqual(getLocalityName('', 'Andheri East', 'Mumbai'), 'Andheri East');
assert.strictEqual(getLocalityName('---', 'Andheri East', 'Mumbai'), 'Mumbai');
assert.strictEqual(getLocalityName(null, null, 'Mumbai'), 'Mumbai');

console.log('Area resolution aliases names by normalized name and slug.');
