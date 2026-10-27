# ML trading system: historical data collection

Download available EUR/USD, USD/JPY, and XAU/USD minute candles or bid/ask ticks
from Dukascopy using Node.js 22 or newer. No API key is required for this feed.

## Coverage and the 30-year requirement

As of October 2026, this free source does **not** provide 30 years of minute or
tick history for these instruments. The
[dukascopy-node instrument catalog](https://www.dukascopy-node.app/instruments)
documents these earliest starts:

| Instrument | Minute/tick start in UTC |
| --- | --- |
| [EUR/USD](https://www.dukascopy-node.app/instrument/eurusd) | 2003-05-04 21:00 |
| [USD/JPY](https://www.dukascopy-node.app/instrument/usdjpy) | 2003-05-04 21:00 |
| [XAU/USD](https://www.dukascopy-node.app/instrument/xauusd) | 2003-05-05 00:01 |

The downloader uses **2003-05-05** as its common start. Advertised daily history
from earlier decades does not establish intraday coverage. Availability dates
also do not guarantee uninterrupted history.

The euro was introduced on
[1 January 1999](https://economy-finance.ec.europa.eu/publications/one-currency-one-europe_en).
Consequently, a 30-year EUR/USD series ending in 2026 necessarily contains a
predecessor or synthetic proxy. Keep that proxy labelled and separate from
actual EUR/USD observations.

For a strict 30-year project, request a per-instrument coverage report and sample
from a licensed vendor such as
[LSEG Tick History](https://www.lseg.com/en/data-analytics/market-data/data-feeds/tick-history).
Its overall archive starts in January 1996; this is not a promise that all three
requested instruments have complete history from that date. Confirm quote
contributors, bid/ask availability, timestamps, licensing, and pre-1999 proxy
methodology before buying. This repository contains the free Dukascopy route,
not an LSEG integration or a claimed complete 30-year dataset.

## Install and run

```bash
npm ci
npm test
```

First download one complete UTC day for all three instruments:

```bash
npm run download -- m1 2026-10-19 2026-10-20
```

Download available minute history, including separate bid and ask candles:

```bash
npm run download -- m1 2003-05-05 2026-10-27
```

For ticks, first measure storage and runtime using a small window:

```bash
npm run download -- tick 2026-10-19 2026-10-20
```

Arguments are `resolution start exclusive-end`. Resolution is `m1` or `tick`.
Defaults are `m1`, `2003-05-05`, and today's date in UTC. The current UTC day
is excluded to avoid checkpointing an unfinished day. End dates are exclusive.
Run one downloader process per output directory; simultaneous writers are not
supported. A full tick archive can be large and slow: there is no guaranteed
download duration or storage estimate.

## Files, validation, and resuming

Example output:

```text
data/dukascopy/eurusd/m1/bid/2026/10/2026-10-19.csv
data/dukascopy/eurusd/m1/bid/2026/10/2026-10-19.csv.json
data/dukascopy/eurusd/m1/ask/2026/10/2026-10-19.csv
data/dukascopy/eurusd/tick/quotes/2026/10/2026-10-19.csv
data/dukascopy/events.jsonl
```

M1 columns: `timestamp,open,high,low,close,volume`.
Tick columns: `timestamp,askPrice,bidPrice,askVolume,bidVolume`.
Timestamps are Unix milliseconds in UTC. Volumes use the provider's `units`
setting; they are provider quote/candle volumes, not consolidated exchange
trading volume for OTC forex or gold.

The downloader requests one day at a time, limits request batches, and retries
failed artifacts. It checks finite numbers, date bounds, ordering, M1 timestamp
uniqueness and minute alignment, OHLC relationships, positive prices,
nonnegative volumes, and uncrossed tick quotes. Multiple ticks sharing one
millisecond are allowed. Invalid partitions are logged as failed and not saved.

Automatic browser-based WAF token acquisition is disabled. If the provider
requires an access challenge, the request fails visibly; use the provider's
supported export/access workflow rather than assuming unattended access works.

Live check on 2026-10-27: requests for 2026-10-19 returned HTTP 202 WAF
challenges for all three instruments and both M1 sides in this environment.
Unattended live downloading is therefore **not verified as working here**.
No sample market data is included. Automated tests use deterministic provider
fixtures to verify validation, checkpoint integrity, recovery, and error handling.

CSV and metadata are written using temporary files and renames. Metadata records
the provider, requested interval, side, row count, first/last timestamp, retrieval
time, and SHA-256 hash. Rerunning the command skips files only when their metadata
matches the request and their hash matches. Corrupted or interrupted partitions
are downloaded again. A valid checkpoint is an integrity check, **not proof of
complete market coverage**; delete both files to refresh a checkpoint if the
provider later revises its history.

Empty responses are logged but never checkpointed. They can indicate weekends,
holidays, unavailable history, or missing upstream files. Failures produce a
nonzero exit code; empty responses are reported separately. Reruns retry both.
An upstream partial day can still contain valid rows, so review intraday gaps
and expected market sessions separately before calling a dataset complete.

Preserve the downloaded data and build cleaned/Parquet datasets separately.
Audit gaps, bid/ask alignment, spreads, and representative prices against an
independent source before backtesting. Do not forward-fill missing minutes or
label daily benchmark prices as intraday quotes. Independent bid/ask OHLC
extremes can occur at different instants; use aligned ticks for exact spread
and execution analysis.

Generated market data and dependencies are excluded from Git. Follow the
provider's applicable data usage terms. The downloader uses the documented
[Node configuration](https://www.dukascopy-node.app/config/node) and
[tick schema](https://www.dukascopy-node.app/downloading-tick-data).
