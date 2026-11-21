# Token Radar v5 — pre-token protocols ranked by implied value

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/cffilham-jpg/makefun-token-radar-01-v5/rank.svg)](https://make.fun/c/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/cffilham-jpg/makefun-token-radar-01-v5/reward.svg)](https://make.fun/c/token-radar-01)

An entry for the [token-radar-01 bounty on make.fun](https://make.fun/c/token-radar-01): a radar that finds protocols whose token does not exist yet, ranks them by an implied value, and shows a reader how to farm each one.

## What it does

- **Board**: all 198 rankable pre-token protocols in the snapshot (the 40-protocol watchlist plus 158 below the floor), ranked by implied value = value-if-launches × fitted P(token). Board total $0.99B implied.
- **Value model**: L1 (median) log-log curve log(mcap) ~ log(TVL) fitted on the 98 traded comps, plus per-family median residual offsets shrunk by n/(n+8). Leave-one-out median miss ×2.56, walk-forward (fit the 37 older-listed comps, test the 37 newer) ×2.24.
- **Honest ranges**: bands are the point × the model's own leave-one-out residual quantiles (P25–P75 ×0.38–×2.31, P10–P90 ×0.14–×4.18). Walk-forward coverage 54% / 70% against stated 50% / 80%.
- **Token odds**: logistic regression (IRLS, ridge λ=1) on the 485 protocols listed ≥1 year, age in years + family only. 10-fold Brier 0.208 vs 0.245 base; walk-forward 0.250 vs 0.353 train-rate baseline. TVL and 7-day growth add nothing, so they are not in the model.
- **Farm plans**: every row carries a costed, timed 6-step plan at a $1,000 standard deposit (per-chain gas, 4% forgone yield over 90 days, 10% airdrop share), with a $10,000 toggle on the board. Verdicts: FARM 2 / MARGINAL 61 / SKIP 135 at $1,000.
- **Evidence on the board**: the board screenshot itself carries the ablation table (LOO + walk-forward), the 758-protocol accounting ledger, the measured band coverage, and the odds ablation.

## Layout

- `main.ts` — entrypoint: reads the snapshot, writes `/output/board.json`, `/output/data.js`, copies `dashboard/` and `screenshots/`, writes `/output/dossier.json`.
- `lib/model.ts` — the model: snapshot parsing, value curve + family offsets, odds logistic regression, out-of-sample evaluation, farm economics, board building. Deterministic: two runs write byte-identical outputs.
- `dashboard/` — the static page (index.html, app.css, app.js; 39,310 bytes total, no network).
- `screenshots/` — the four dossier images: board, detail, filtered, method (1440×900 PNG).
- `vendor/makefun-board.ts` — make.fun's dossier library, copied from the kit starter as the rules require.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to>/snapshot.json
```

Node 22.18 or later, standard library only, no install.
