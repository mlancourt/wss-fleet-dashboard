# test fixtures

Synthetic files only. Same rule as everything else in this repo (CLAUDE.md, hard
rule 1): **no real customer document ever lands here**, not even a redacted one.

| File | What it is |
|---|---|
| `sample-quote.pdf` | A 24 KB machine-generated PDF — one page of filler lines. It is a *valid* PDF (opens in any viewer) because `tools/m1-loop.sh` uploads it, reads it back, and the point of the loop is that the bytes survive the round-trip intact. It contains nothing. |
| `sample-photo.png` | A 94-byte 8x8 PNG of a grey ramp. Exists so the loop exercises the `image/png` branch of the upload — the S2 crew POST accepts three MIME types and only one of them was covered by the PDF. |

Every doc id here is the first 16 hex of the file's SHA-256 — the loop script
computes it rather than hard-coding it, so re-generating a fixture breaks
nothing.
