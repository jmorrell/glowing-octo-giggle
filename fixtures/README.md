# Fixtures

All fixtures are synthetic. None contains personal or production data.

| File | What it is | How it was made |
| --- | --- | --- |
| `inspection.webm` | 15 s, 160×90 VP8 video of a colour-cycling canvas | `node scripts/make-video-fixture.mjs` (Chromium `MediaRecorder`) |
| `bracket-assembly.step` | Hand-written ISO 10303-21 file: three `PRODUCT`s, two assembly links, three points | By hand |
| `bridge-sensors.parquet` | 120,000 rows × 4 columns, snappy, 4 row groups of 30,000, no page index | DuckDB 1.5.6, command below |

Transcripts, frames, and image descriptions are not fixtures: the mocked vendor in
`src/host/vendor.ts` returns them.

```sql
COPY (
  SELECT
    TIMESTAMP '2026-09-01 00:00:00' + to_seconds(i * 15) AS ts,
    ['north-anchorage', 'south-anchorage', 'deck-midspan'][1 + i % 3] AS sensor,
    round(120 + 40 * sin(i / 500.0) + (hash(i) % 1000) / 100.0, 2) AS strain_microstrain,
    round(12 + 8 * sin(i / 5760.0) + (hash(i * 7) % 100) / 50.0, 2) AS temperature_c
  FROM range(0, 120000) t(i)
) TO 'fixtures/bridge-sensors.parquet' (FORMAT parquet, COMPRESSION snappy, ROW_GROUP_SIZE 30000);
```
