const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseDate, parseOptions, validateRows, download } =
  require('../scripts/download-history.cjs');

const from = parseDate('2026-10-19');
const to = parseDate('2026-10-20');
const candle = { timestamp: +from, open: 1.1, high: 1.2,
  low: 1, close: 1.15, volume: 10 };

test('rejects impossible dates, unsupported resolutions, and unsupported history', () => {
  assert.throws(() => parseDate('2026-02-30'));
  assert.throws(() => parseOptions(['d1']));
  assert.throws(() => parseOptions(['m1', '1996-01-01', '2026-10-27']));
  assert.throws(() => parseOptions(['m1', '2026-10-20', '2026-10-19']));
  assert.throws(() => parseOptions(['tick', '2026-10-19', '2026-10-28'], to));
});

test('checks candle boundaries, duplicate timestamps, and OHLC relationships', () => {
  validateRows([candle], 'm1', from, to);
  assert.throws(() => validateRows([candle, candle], 'm1', from, to));
  assert.throws(() => validateRows([{ ...candle, timestamp: +to }], 'm1', from, to));
  assert.throws(() => validateRows([{ ...candle, high: 1.05 }], 'm1', from, to));
  assert.throws(() => validateRows([{ ...candle, close: NaN }], 'm1', from, to));
});

test('allows equal tick timestamps but rejects crossed quotes', () => {
  const tick = { timestamp: +from, askPrice: 1.2, bidPrice: 1.1,
    askVolume: 1, bidVolume: 2 };
  validateRows([tick, tick], 'tick', from, to);
  assert.throws(() => validateRows([{ ...tick, askPrice: 1 }], 'tick', from, to));
});

test('resumes completed files, repairs corruption, and retries empty partitions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fx-history-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { timeframe: 'm1', from, to };
  let calls = 0;
  const provider = async config => {
    calls++;
    assert.equal(config.format, 'json');
    assert.equal(config.failAfterRetryCount, true);
    assert.equal(config.wafMode, 'off');
    return [candle];
  };
  assert.deepEqual(await download(options, provider, root), { failures: 0, empty: 0 });
  assert.equal(calls, 6);
  await download(options, provider, root);
  assert.equal(calls, 6);
  const file = path.join(root, 'eurusd/m1/bid/2026/10/2026-10-19.csv');
  await fs.writeFile(file, 'corrupted');
  await download(options, provider, root);
  assert.equal(calls, 7);
  await fs.unlink(file);
  assert.deepEqual(await download(options, async () => [], root), { failures: 0, empty: 1 });
  await download(options, provider, root);
  assert.equal(calls, 8);
});

test('failed downloads remain retryable and are reported', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fx-history-fail-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { timeframe: 'm1', from, to };
  const result = await download(options, async () => { throw new Error('HTTP failure'); }, root);
  assert.equal(result.failures, 6);
  const events = (await fs.readFile(path.join(root, 'events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(events.length, 6);
  assert.equal(JSON.parse(events[0]).status, 'failed');
});
