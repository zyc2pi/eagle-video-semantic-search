const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const valid = { version: 1, port: 5006, pid: 123, token: 'a'.repeat(64) };
let record = valid;
let readFailure = false;
const context = {
  require: (name) => name === 'fs' ? { readFileSync: (filename) => {
    assert.strictEqual(filename, path.join('D:/fixture-backend', 'state', 'search-control-5006.json'));
    if (readFailure) throw new Error('test denied');
    return JSON.stringify(record);
  } } : require(name),
  Config: { get: () => ({ projectRoot: 'D:/fixture-backend', port: 5006 }) },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/service.js'), 'utf8') + '\nthis.Service = Service;', context);
assert.strictEqual(context.Service.controlHeaders()['X-Eagle-Control-Token'], 'a'.repeat(64));
for (const invalid of [{ ...valid, port: 5007 }, { ...valid, token: 'invalid' }, { ...valid, version: 2 }]) {
  record = invalid;
  assert.throws(() => context.Service.controlHeaders(), /控制凭据不可用/);
}
readFailure = true;
assert.throws(() => context.Service.controlHeaders(), /控制凭据不可用/);
console.log('Service shared control credential validation passed');
