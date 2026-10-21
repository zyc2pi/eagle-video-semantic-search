const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const context = {
  AbortController, setTimeout, clearTimeout,
  Config: { get: () => ({}), baseUrl: () => 'http://127.0.0.1:5006' },
  Service: { controlHeaders: () => ({ 'X-Eagle-Control-Token': 'test-only-token' }) },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/api.js'), 'utf8') + '\nthis.Api = Api;', context);

async function main() {
  // Headers arrive promptly, but reading the response body can still be aborted.
  let bodyStarted;
  const ready = new Promise((resolve) => { bodyStarted = resolve; });
  context.fetch = async (_url, { signal }) => ({ ok: true, status: 200, json: () => {
    bodyStarted();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('body interrupted'), { name: 'AbortError' }));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  } });
  const controller = new AbortController();
  const cancelled = context.Api.search('body', [], 1, null, {}, { signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  await assert.rejects(context.Api.search('body', [], 1, null, {}, { timeoutMs: 2 }), { name: 'TimeoutError' });

  context.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('broken transport'); } });
  await assert.rejects(context.Api.search('body', [], 1), /broken transport/);
  context.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('malformed JSON'); } });
  assert.strictEqual((await context.Api.search('body', [], 1)).data, null);

  for (const response of [
    { ok: false, status: 500, data: { success: false, error: 'coverage failed' } },
    { ok: true, status: 200, data: { success: false, error: 'coverage failed' } },
    { ok: true, status: 200, data: null },
    { ok: true, status: 200, data: { success: true, video_paths: 'bad shape' } },
  ]) {
    context.fetch = async () => ({ ...response, json: async () => response.data });
    await assert.rejects(context.Api.indexCoverage('index'), /coverage failed|覆盖状态|格式/);
  }
  context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true, video_paths: [], skipped_paths: ['skip'] }) });
  assert.deepStrictEqual(Array.from((await context.Api.indexCoverage('index')).processedPaths), ['skip']);

  let sent;
  context.fetch = async (url, options) => { sent = { url, options }; return { ok: true, status: 200, json: async () => ({ success: true }) }; };
  await context.Api.shutdown();
  assert(sent.url.endsWith('/shutdown'));
  assert.strictEqual(sent.options.headers['X-Eagle-Control-Token'], 'test-only-token');
  console.log('API response-body abort, coverage failure and authenticated shutdown passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
