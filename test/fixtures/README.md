# test fixtures

Synthetic files only. Same rule as everything else in this repo (CLAUDE.md, hard
rule 1): **no real customer document ever lands here**, not even a redacted one.

| File | What it is |
|---|---|
| `sample-quote.pdf` | A 24 KB machine-generated PDF — one page of filler lines. It is a *valid* PDF (opens in any viewer) because `tools/m1-loop.sh` uploads it, reads it back, and the point of the loop is that the bytes survive the round-trip intact. It contains nothing. |

`sample-quote.pdf`'s doc id is the first 16 hex of its SHA-256 — the loop script
computes it rather than hard-coding it, so re-generating the file breaks nothing.
