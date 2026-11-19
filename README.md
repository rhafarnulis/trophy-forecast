# trophy-forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/rhafarnulis/trophy-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/rhafarnulis/trophy-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts, for every PlayStation 5 trophy of Grand Theft Auto VI, its earn
rate on Exophase at the case's target — five quantiles (5, 25, 50, 75, 95%)
of the rate in percent. One program, `main.ts` (Node 22, standard library
only), reads every `*.in` case in `$MAKEFUN_INPUT_DIR` (else `/input/`) and
writes one `/output/<id>.out` per case.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Runs in well under a second per case, deterministic: the same case always
writes the same bytes.

## The model

The score is mean pinball loss on the logit scale, so a forecast is good
when its median sits where the rate will land and its spread is honest
about how far the rate can move.

**Median — a trend, not a freeze.** For each trophy, a least-squares line
is fit to logit(rate) against ln(1 + hours since release) over the case's
reads in the last 24 hours before the checkpoint (all reads when there are
fewer than three in that window), and read at the target. With fewer than
three usable points the median is the trophy's last rate. The extrapolated
logit is clamped to four logits either side of the last rate, so a steep
early slope cannot throw the forecast somewhere absurd four days out.

**Spread — four honest sources of doubt, combined in quadrature:**

- **Random walk:** 0.70 × √(horizon in days). Rates diffuse, and a week of
  player growth after launch moves them a lot.
- **Refresh jump:** 0.90, always. Exophase refreshes on its own schedule;
  at a refresh the tracked player count jumps and almost every rate drops
  at once — on launch night the first refresh took the count from 638 to
  3,868 and every rate but the one at 100% fell, about −1.4 logits in
  ninety minutes.
- **Fit residual:** the standard deviation of the line fit's residuals.
- **Slope doubt:** the standard error of the fitted slope, times the
  extrapolation distance to the target, capped at 1.0.

The total is floored at 0.50 and capped at 2.50 on the logit scale.
Quantiles are the median plus the normal's z at each level, mapped back
through the inverse logit. Rates are clamped to 0.01–99.99 before any
logit, since 0% and 100% have no logit.

## Practice validation

The kit's practice cases (p00/p01) have flat histories — every read is the
unchanged launch-night page — and their answers are the refreshed page,
which the kit does not ship. Scored against refresh scenarios built from
what the rules state (tracked players 638 → 3,868 at the refresh, the 100%
trophy unchanged, new players earning at 0%, 10% or 25% of the old rates),
this forecast beats the house baseline (median = last rate, spread
0.5·√days) in every scenario:

| answer scenario | house baseline | this forecast |
|---|---|---|
| new players earn 0% | 1.69 | 1.12 |
| new players earn 10% | 1.28 | 0.76 |
| new players earn 25% | 0.88 | 0.52 |

The rules report the baseline's true practice loss at about 1.51 with a
typical miss of about 0.68 points — between the first two scenarios —
which puts this forecast at about 0.95–1.05 on the practice. The practice
pays nothing; the final case (f00, 6,510-minute horizon) is what counts,
and a synthetic f00-shaped case with two days of drifting history runs
cleanly in ~0.5 s with a valid 55-row forecast.

## Files

- `main.ts` — the forecast program.
- `LICENSE` — MIT.

---

New here? Join make.fun with my link: https://make.fun/r/2s4v23h1 — my
referral code is `2s4v23h1`.
