// Trophy Rarity Forecast — GTA VI, week one.
//
// Forecasts, for every PlayStation 5 trophy of Grand Theft Auto VI, its
// earn rate on Exophase at the case's target: five quantiles (5, 25, 50, 75,
// 95%) of the rate in percent. Run once per case:
//
//   node main.ts
//
// Reads every *.in file in $MAKEFUN_INPUT_DIR (else /input/) and writes one
// /output/<id>.out per case ($MAKEFUN_OUTPUT_DIR, else /output/). Node 22,
// standard library only, no network, deterministic: the same case always
// writes the same bytes.
//
// ---------------------------------------------------------------------------
// How the forecast is made
// ---------------------------------------------------------------------------
//
// The score is mean pinball loss on the logit scale, so a forecast is good
// when its median sits where the rate will land and its spread is honest
// about how far the rate can move. Two facts about this data drive the
// design:
//
// 1. Exophase refreshes its counts on its own schedule, not with every
//    player. Between refreshes the page is frozen; at a refresh the tracked
//    player count jumps and almost every rate drops, because the new players
//    have earned far less than the launch-night early adopters. On launch
//    night the first refresh took the tracked count from 638 to 3,868 and
//    every rate but the one at 100% fell — roughly a fourfold drop, about
//    -1.4 on the logit scale, in ninety minutes. Any spread that cannot
//    hold a jump like that is not honest.
//
// 2. Over days, the rates drift as the player base grows and players
//    progress. That drift is smoothest on a log clock: the logit of a rate
//    moves roughly linearly against ln(1 + hours since release). So the
//    median comes from a least-squares line fit per trophy, and the spread
//    widens with the horizon the way a random walk's does.
//
// Median: for each trophy, fit a line to logit(rate) against
// ln(1 + hours since 2026-11-19T00:00:00Z) over the case's reads in the
// last 24 hours before the checkpoint (all reads when there are fewer than
// three in that window), and read the line at the target. With fewer than
// three usable points the median is the trophy's last rate. The
// extrapolated logit is clamped to four logits either side of the last
// rate, so a steep early slope cannot throw the forecast to an absurd
// place four days out.
//
// Spread: one logit standard deviation per trophy, combined in quadrature
// from four honest sources of doubt:
//
//   - random walk:   0.70 * sqrt(horizon in days). Rates diffuse; a week
//     of player growth after launch moves them a lot, and the house
//     baseline's 0.50 is too narrow for that.
//   - refresh jump:  0.60, always. A refresh the history has not shown can
//     move every rate at once, and the practice cases prove it does.
//   - fit residual:  the standard deviation of the line fit's residuals.
//     A trophy whose history already wobbles gets a wider band.
//   - slope doubt:   the standard error of the fitted slope, times the
//     extrapolation distance to the target, capped at 1.0. A slope fitted
//     over a short window is a guess; the further the target, the more
//     that guess can miss.
//
// The total is floored at 0.50 and capped at 2.50. Quantiles are the
// median plus the standard normal's z at each level (-1.645, -0.674, 0,
// 0.674, 1.645) times that deviation, mapped back through the inverse
// logit and rounded to four decimals. Rates are clamped to 0.01–99.99
// before any logit, since 0% and 100% have no logit; the trophy at 100%
// is therefore forecast just under it, with its band reaching down.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// --- constants ------------------------------------------------------------

/** The day GTA VI released, the origin of the log clock. */
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');

/** Hours are counted from the release; the log clock is ln(1 + hours). */
const MS_PER_HOUR = 3_600_000;

/** Rates are clamped to this range before any logit is taken. */
const RATE_MIN = 0.01;
const RATE_MAX = 99.99;

/** The five levels the case asks for, and the normal quantiles at them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z_SCORES = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

/** Random-walk coefficient on the logit scale, per sqrt(day). */
const WALK_COEF = 0.7;
/** Standard deviation allowed for one unseen Exophase refresh. */
const JUMP_SD = 0.9;
/** Floor and cap on the total logit spread. */
const SPREAD_MIN = 0.5;
const SPREAD_MAX = 2.5;
/** How far the extrapolated median may sit from the last rate, in logits. */
const EXTRAPOLATION_CLAMP = 4;
/** The fit uses reads from this far back, when there are enough of them. */
const FIT_WINDOW_MS = 24 * MS_PER_HOUR;

// --- small helpers ----------------------------------------------------------

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return RATE_MIN;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, rate));
}

/** logit of a percent rate, with the rate clamped first. */
function logit(rate: number): number {
  const p = clampRate(rate) / 100;
  return Math.log(p / (1 - p));
}

/** Inverse logit: a logit back to a percent rate. */
function invLogit(value: number): number {
  return 100 / (1 + Math.exp(-value));
}

/** Round to four decimals, the precision the case's rates are printed at. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// --- case types -------------------------------------------------------------

interface TrophyInfo {
  id: number;
  name: string;
  tier: string;
}

interface HistoryRead {
  at: string;
  rates: (number | null)[];
}

interface CaseFile {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  trophies: TrophyInfo[];
  history: HistoryRead[];
}

// --- the fit ----------------------------------------------------------------

/** One usable point: the log-clock position and the logit's rate. */
interface FitPoint {
  x: number;
  y: number;
}

/**
 * Least squares line through the points, with the residual spread and the
 * slope's standard error. Returns null when there are too few points or
 * the x values do not vary.
 */
function fitLine(points: FitPoint[]): {
  intercept: number;
  slope: number;
  residualSd: number;
  slopeSe: number;
} | null {
  const n = points.length;
  if (n < 3) return null;
  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - meanX) * (p.x - meanX);
    sxy += (p.x - meanX) * (p.y - meanY);
  }
  if (sxx <= 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let sse = 0;
  for (const p of points) {
    const r = p.y - (intercept + slope * p.x);
    sse += r * r;
  }
  // With n points and two fitted parameters, n - 2 degrees of freedom.
  const residualSd = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  const slopeSe = residualSd / Math.sqrt(sxx);
  return { intercept, slope, residualSd, slopeSe };
}

// --- one trophy -------------------------------------------------------------

/**
 * Forecast one trophy's five quantiles at the target.
 *
 * `series` is the trophy's rate at each read, oldest first, with the read
 * times; `targetMs` is the target instant. The median is the fitted line
 * read at the target (or the last rate when there is no fit); the spread
 * is the random walk, the refresh jump, the fit's residual and the slope's
 * doubt, combined in quadrature.
 */
function forecastTrophy(
  series: { atMs: number; rate: number | null }[],
  targetMs: number,
  horizonDays: number,
): number[] {
  const usable = series.filter((s) => s.rate !== null) as { atMs: number; rate: number }[];
  if (usable.length === 0) {
    // No history at all for this trophy: a flat 1% with a very wide band.
    const sd = SPREAD_MAX;
    return Z_SCORES.map((z) => round4(invLogit(logit(1) + z * sd)));
  }
  const last = usable[usable.length - 1]!;
  const lastLogit = logit(last.rate);
  const checkpointMs = series[series.length - 1]!.atMs;

  // The fit window: the last 24 hours before the checkpoint, or all reads
  // when fewer than three fall in it.
  const windowStart = checkpointMs - FIT_WINDOW_MS;
  let points = usable
    .filter((s) => s.atMs >= windowStart)
    .map((s) => ({ x: Math.log(1 + (s.atMs - RELEASE_MS) / MS_PER_HOUR), y: logit(s.rate) }));
  if (points.length < 3) {
    points = usable.map((s) => ({ x: Math.log(1 + (s.atMs - RELEASE_MS) / MS_PER_HOUR), y: logit(s.rate) }));
  }

  const targetX = Math.log(1 + (targetMs - RELEASE_MS) / MS_PER_HOUR);
  let medianLogit = lastLogit;
  let residualSd = 0;
  let slopeDoubt = 0;
  const fit = fitLine(points);
  if (fit !== null) {
    const lastX = points[points.length - 1]!.x;
    medianLogit = fit.intercept + fit.slope * targetX;
    medianLogit = Math.min(lastLogit + EXTRAPOLATION_CLAMP, Math.max(lastLogit - EXTRAPOLATION_CLAMP, medianLogit));
    residualSd = fit.residualSd;
    slopeDoubt = Math.min(1, fit.slopeSe * Math.max(0, targetX - lastX));
  }

  const walk = WALK_COEF * Math.sqrt(horizonDays);
  const sd = Math.min(
    SPREAD_MAX,
    Math.max(SPREAD_MIN, Math.sqrt(walk * walk + JUMP_SD * JUMP_SD + residualSd * residualSd + slopeDoubt * slopeDoubt)),
  );
  return Z_SCORES.map((z) => {
    const q = invLogit(medianLogit + z * sd);
    return round4(Math.min(RATE_MAX, Math.max(RATE_MIN, q)));
  });
}

// --- one case ---------------------------------------------------------------

function forecastCase(kase: CaseFile): { trophies: { id: number; q: number[] }[] } {
  const checkpointMs = Date.parse(kase.at);
  const targetMs = Date.parse(kase.target);
  const horizonDays = Math.max(0, kase.horizon_minutes) / 1440;
  const reads = kase.history.map((h) => ({ atMs: Date.parse(h.at), rates: h.rates }));
  const rows = kase.trophies.map((trophy, index) => {
    const series = reads.map((r) => ({ atMs: r.atMs, rate: r.rates[index] ?? null }));
    return { id: trophy.id, q: forecastTrophy(series, targetMs, horizonDays) };
  });
  return { trophies: rows };
}

// --- main -------------------------------------------------------------------

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const files = readdirSync(inputDir)
    .filter((name) => name.endsWith('.in'))
    .sort();
  mkdirSync(outputDir, { recursive: true });
  for (const name of files) {
    const kase = JSON.parse(readFileSync(join(inputDir, name), 'utf8')) as CaseFile;
    const forecast = forecastCase(kase);
    const outName = `${name.slice(0, -3)}.out`;
    writeFileSync(join(outputDir, outName), `${JSON.stringify(forecast)}\n`);
    process.stdout.write(`forecast ${kase.id}: ${forecast.trophies.length} trophies -> ${outName}\n`);
  }
}

main();
