const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const context = {
  AbortController, setTimeout, clearTimeout,
  Config: { get: () => ({}), baseUrl: () => 'http://test' },
  fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    const abort = () => { const error = new Error(); error.name = 'AbortError'; reject(error); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }),
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8') + '\nthis.Api = Api;', context);
async function main() {
  const c = new AbortController();
  const request = context.Api.search('test', [], 0, null, {}, { signal: c.signal });
  c.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await assert.rejects(context.Api.search('test', [], 0, null, {}, { timeoutMs: 1 }), { name: 'TimeoutError' });
  await assert.rejects(context.Api.searchVisual({}, [], 0, null, {}, { signal: c.signal }), { name: 'AbortError' });
  await assert.rejects(context.Api.searchHybrid('test', {}, [], 0, null, {}, { signal: c.signal }), { name: 'AbortError' });
  context.fetch = async (url, options) => {
    assert.strictEqual(url, 'http://test/api/v1/libraries/associate');
    assert.deepStrictEqual(JSON.parse(options.body), { library_id: 'stable-id', path: 'D:/moved', confirm: true });
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  await context.Api.associateLibrary('stable-id', 'D:/moved');
  console.log('API caller cancellation and timeout distinction passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
