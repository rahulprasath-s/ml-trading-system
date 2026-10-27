const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const DAY = 86_400_000;
const SYMBOLS = ['eurusd', 'usdjpy', 'xauusd'];
const COLUMNS = {
  m1: ['timestamp', 'open', 'high', 'low', 'close', 'volume'],
  tick: ['timestamp', 'askPrice', 'bidPrice', 'askVolume', 'bidVolume'],
};

function parseDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(+date)
      || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid date: ${value}; expected YYYY-MM-DD`);
  }
  return date;
}

function parseOptions(args, now = new Date()) {
  if (args.length > 3) throw new Error('Expected: [m1|tick] [start] [exclusive-end]');
  const [timeframe = 'm1', start = '2003-05-05',
    end = now.toISOString().slice(0, 10)] = args;
  if (!Object.hasOwn(COLUMNS, timeframe)) throw new Error('Use m1 or tick');
  const from = parseDate(start);
  const to = parseDate(end);
  if (from < parseDate('2003-05-05')) {
    throw new Error('Common Dukascopy minute/tick coverage starts 2003-05-05, not 1996');
  }
  if (+from >= +to || to > parseDate(now.toISOString().slice(0, 10))) {
    throw new Error('Require start < exclusive-end <= today (UTC)');
  }
  return { timeframe, from, to };
}

function validateRows(rows, timeframe, from, to) {
  if (!Array.isArray(rows)) throw new Error('Expected an array of quote/candle objects');
  let previous = -Infinity;
  for (const row of rows) {
    for (const column of COLUMNS[timeframe]) {
      if (!Number.isFinite(row[column])) throw new Error(`Invalid ${column}`);
    }
    const timestamp = row.timestamp;
    if (!Number.isSafeInteger(timestamp) || timestamp < +from || timestamp >= +to
        || timestamp < previous || (timeframe === 'm1' && timestamp === previous)) {
      throw new Error('Out-of-range, unordered, or duplicate candle timestamp');
    }
    if (timeframe === 'm1') {
      if (timestamp % 60_000 !== 0 || row.low <= 0
          || row.high < Math.max(row.open, row.close, row.low)
          || row.low > Math.min(row.open, row.close) || row.volume < 0) {
        throw new Error('Invalid M1 candle or volume');
      }
    } else if (row.bidPrice <= 0 || row.askPrice < row.bidPrice
        || row.askVolume < 0 || row.bidVolume < 0) {
      throw new Error('Invalid/crossed quote or negative quote volume');
    }
    // Multiple distinct ticks can legitimately share one millisecond.
    previous = timestamp;
  }
}

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function isComplete(file, request) {
  try {
    const metadata = JSON.parse(await fs.readFile(`${file}.json`, 'utf8'));
    const content = await fs.readFile(file);
    return metadata.rows > 0 && metadata.sha256 === hash(content)
      && Object.entries(request).every(([key, value]) => metadata[key] === value);
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function atomicWrite(file, content) {
  await fs.writeFile(`${file}.part`, content);
  await fs.rename(`${file}.part`, file);
}

async function download(options, getHistoricalRates, root = 'data/dukascopy') {
  let failures = 0;
  let empty = 0;
  await fs.mkdir(root, { recursive: true });
  const { timeframe, from, to } = options;
  for (const instrument of SYMBOLS) {
    const sides = timeframe === 'tick' ? ['quotes'] : ['bid', 'ask'];
    for (let time = +from; time < +to; time += DAY) {
      const dayFrom = new Date(time);
      const dayTo = new Date(time + DAY);
      const date = dayFrom.toISOString().slice(0, 10);
      for (const side of sides) {
        const file = path.join(root, instrument, timeframe, side,
          date.slice(0, 4), date.slice(5, 7), `${date}.csv`);
        const request = { provider: 'Dukascopy', instrument, timeframe, side,
          from: dayFrom.toISOString(), to: dayTo.toISOString() };
        if (await isComplete(file, request)) continue;
        try {
          const config = {
            instrument, dates: { from: dayFrom, to: dayTo }, timeframe,
            format: 'json', utcOffset: 0, volumes: true, volumeUnits: 'units',
            // Report access challenges; do not launch a browser automatically.
            wafMode: 'off',
            ignoreFlats: false, batchSize: 4, pauseBetweenBatchesMs: 1000,
            retryCount: 3, failAfterRetryCount: true,
            pauseBetweenRetriesMs: 1500,
          };
          if (timeframe === 'm1') config.priceType = side;
          const rows = await getHistoricalRates(config);
          validateRows(rows, timeframe, dayFrom, dayTo);
          if (rows.length === 0) {
            empty++;
            await fs.appendFile(path.join(root, 'events.jsonl'),
              `${JSON.stringify({ ...request, status: 'empty', checkedAt: new Date().toISOString() })}\n`);
            console.warn(`EMPTY ${instrument} ${side} ${date}`);
            continue;
          }
          const columns = COLUMNS[timeframe];
          const csv = `${columns.join(',')}\n${rows.map(row =>
            columns.map(column => row[column]).join(',')).join('\n')}\n`;
          await fs.mkdir(path.dirname(file), { recursive: true });
          await atomicWrite(file, csv);
          await atomicWrite(`${file}.json`, JSON.stringify({ ...request,
            rows: rows.length, firstTimestamp: rows[0].timestamp,
            lastTimestamp: rows.at(-1).timestamp, sha256: hash(csv),
            volumeUnits: 'units', retrievedAt: new Date().toISOString(),
          }, null, 2));
          console.log(`SAVED ${instrument} ${side} ${date}: ${rows.length} rows`);
        } catch (error) {
          failures++;
          await fs.appendFile(path.join(root, 'events.jsonl'),
            `${JSON.stringify({ ...request, status: 'failed', error: error.message })}\n`);
          console.error(`FAILED ${instrument} ${side} ${date}: ${error.message}`);
        }
      }
    }
  }
  console.log(`Finished: ${failures} failed, ${empty} empty partitions. Empty does not prove market closure.`);
  return { failures, empty };
}

if (require.main === module) {
  (async () => {
    const options = parseOptions(process.argv.slice(2));
    const { getHistoricalRates } = require('dukascopy-node');
    const result = await download(options, getHistoricalRates);
    if (result.failures) process.exitCode = 1;
  })().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseDate, parseOptions, validateRows, download, isComplete };
