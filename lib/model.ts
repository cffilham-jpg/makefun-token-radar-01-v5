// Token radar v5 — the model: one sealed snapshot in, one ranked board out.
//
// The board ranks every pre-token protocol the snapshot can rank (198 rows:
// the 40-protocol watchlist plus the 158 other rankable pre-token protocols),
// by implied value = value-if-launches x P(token). The value comes from the
// market's own traded protocols; the odds come from how often protocols of
// the same age and family record a token. Nothing here names a protocol:
// the same functions score every row, and every number on the board is
// computed from the snapshot in this run.
//
//   value model  L1 (median) log-log curve, log(mcap) ~ log(TVL), fitted on
//                the 98 traded comps (0.02 <= mcap/TVL <= 10, no CEX), plus
//                per-family median residual offsets shrunk by n/(n+8).
//                Bands are honest: the point times the quantiles of the
//                model's own leave-one-out log-residuals, not a bootstrap.
//   odds model   logistic regression (IRLS, ridge lambda=1) on the 485
//                protocols listed >= 365 days, age in years + family only:
//                TVL and 7-day growth add nothing (10-fold Brier 0.209 /
//                0.210 with them, 0.208 without). The target is "records a
//                token by the snapshot date", a LOWER BOUND on ever
//                launching — the dashboard says so.
//   verdicts     on the point net of a $1,000 standard farm: FARM when the
//                net beats a T-bill return AND $25/hour of farm time,
//                MARGINAL when the net is positive, else SKIP.
//
// Written in-session for this entry from the research spec and the snapshot;
// the starter's model.ts was read only for the gate shape (the interfaces
// main.ts imports). Deterministic: no clock, no randomness, every sort has
// a slug tiebreak, so two runs write byte-identical outputs.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label. */
export const MODEL_VERSION = 'radar-5';

/** Shrinkage strength for family offsets: offset x n/(n+SHRINK_K). */
export const SHRINK_K = 8;
/** Ridge penalty for the odds logistic regression (intercept unpenalised). */
export const ODDS_LAMBDA = 1;
/** The standard farm: deposit, hold, forgone yield, T-bill hurdle, airdrop share. */
export const DEPOSIT_USD = 1000;
export const HOLD_DAYS = 90;
export const FORGONE_APR = 0.04;
export const TBILL_APR = 0.043;
export const AIRDROP_SHARE = 0.1;
/** FARM needs this much net per hour of farm time, on top of beating T-bills. */
export const HOURLY_HURDLE_USD = 25;
/** Transactions in one farm plan (approve, deposit, two actions, claim). */
export const FARM_TXS = 5;
/** Minutes of attention a week of farming takes, plus setup and claim. */
export const SETUP_MINUTES = 30;
export const WEEKLY_MINUTES = 10;
export const CLAIM_MINUTES = 15;

/** The seven families every category maps into; anything unlisted is Other. */
export const FAMILIES = ['Lending', 'Trading', 'Vaults & yield', 'RWA', 'Staking', 'Infra', 'Other'] as const;
export type Family = (typeof FAMILIES)[number];

const CATEGORY_FAMILY: Record<string, Family> = {
  Lending: 'Lending',
  'Uncollateralized Lending': 'Lending',
  CDP: 'Lending',
  'CDP Manager': 'Lending',
  'Collateral Management': 'Lending',
  'Collateral Markets': 'Lending',
  Dexs: 'Trading',
  Derivatives: 'Trading',
  Options: 'Trading',
  'Basis Trading': 'Trading',
  Synthetics: 'Trading',
  'OTC Marketplace': 'Trading',
  'Interest Rate Derivatives': 'Trading',
  'Options Vault': 'Trading',
  'Prediction Market': 'Trading',
  Yield: 'Vaults & yield',
  'Yield Aggregator': 'Vaults & yield',
  Farm: 'Vaults & yield',
  'Leveraged Farming': 'Vaults & yield',
  'Liquidity Manager': 'Vaults & yield',
  'Risk Curators': 'Vaults & yield',
  'Onchain Capital Allocator': 'Vaults & yield',
  Indexes: 'Vaults & yield',
  'Anchor BTC': 'Vaults & yield',
  RWA: 'RWA',
  'Stablecoin Issuer': 'RWA',
  'Algo-Stables': 'RWA',
  'Dual-Token Stablecoin': 'RWA',
  'Stablecoin Wrapper': 'RWA',
  'Reserve Currency': 'RWA',
  'Crypto Card Issuer': 'RWA',
  'Staking Pool': 'Staking',
  'Liquid Staking': 'Staking',
  'Liquid Restaking': 'Staking',
  Restaking: 'Staking',
  'Restaked BTC': 'Staking',
  'Decentralized BTC': 'Staking',
  Chain: 'Infra',
  'Cross Chain Bridge': 'Infra',
  Bridge: 'Infra',
  'Canonical Bridge': 'Infra',
  Launchpad: 'Infra',
  Privacy: 'Infra',
  'Decentralized AI': 'Infra',
  'NFT Marketplace': 'Infra',
};

/** A protocol's family, from its DefiLlama category. */
export function familyOf(p: SnapshotProtocol): Family {
  return (p.category !== null && CATEGORY_FAMILY[p.category]) || 'Other';
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- statistics

/** The median of a non-empty array. */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A quantile by linear interpolation (q in [0,1]). */
export function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

/** Spearman's rank correlation. */
export function spearman(xs: number[], ys: number[]): number {
  const rank = (a: number[]): number[] => {
    const idx = a.map((v, i) => [v, i] as [number, number]).sort((x, y) => x[0] - y[0]);
    const r = new Array<number>(a.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

/** Ordinary least squares for y ~ a + b*x, optionally weighted. */
function ols(xs: number[], ys: number[], ws?: number[]): { a: number; b: number } {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws === undefined ? 1 : ws[i]!;
    sw += w;
    sx += w * xs[i]!;
    sy += w * ys[i]!;
    sxx += w * xs[i]! * xs[i]!;
    sxy += w * xs[i]! * ys[i]!;
  }
  const b = (sw * sxy - sx * sy) / (sw * sxx - sx * sx);
  return { a: (sy - b * sx) / sw, b };
}

/**
 * L1 (least absolute deviations) fit of y ~ a + b*x by iteratively
 * reweighted least squares, starting from OLS. Converges to the median
 * regression line; deterministic.
 */
export function l1Fit(xs: number[], ys: number[], iters = 100): { a: number; b: number } {
  let { a, b } = ols(xs, ys);
  for (let it = 0; it < iters; it++) {
    const res = xs.map((x, i) => ys[i]! - (a + b * x));
    const scale = Math.max(median(res.map(Math.abs)), 1e-9);
    const ws = res.map((r) => 1 / Math.max(Math.abs(r), 0.05 * scale));
    const f = ols(xs, ys, ws);
    if (Math.abs(f.a - a) < 1e-10 && Math.abs(f.b - b) < 1e-10) {
      a = f.a;
      b = f.b;
      break;
    }
    a = f.a;
    b = f.b;
  }
  return { a, b };
}

/** Solve a small dense linear system by Gaussian elimination with pivoting. */
export function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    const d = m[c]![c]!;
    for (let r = 0; r < n; r++) {
      if (r === c || m[r]![c] === 0) continue;
      const f = m[r]![c]! / d;
      for (let cc = c; cc <= n; cc++) m[r]![cc]! -= f * m[c]![cc]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

// ---------------------------------------------------------------- snapshot

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol's record carries any token (market cap, CoinGecko id or symbol). */
export function hasTokenRecord(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return !hasTokenRecord(p);
}

/** Categories the watchlist rule excludes: bridges, liquid staking and exchanges. */
export const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A wrapped, staked or staking product of a protocol whose token already trades. */
const WRAPPED_NAME = /\b(wrapped|staked|staking)\b/i;
/** A name beginning with an exchange's name. */
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** Why a pre-token protocol is not rankable, or null when it is. */
export function rankableIssue(p: SnapshotProtocol): 'excluded-category' | 'wrapped-name' | 'exchange-name' | 'versioned-name' | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return 'excluded-category';
  if (WRAPPED_NAME.test(p.name)) return 'wrapped-name';
  if (EXCHANGE_NAME.test(p.name)) return 'exchange-name';
  if (VERSIONED.test(p.name)) return 'versioned-name';
  return null;
}

/** Whether a protocol is one the board may rank: pre-token and not excluded by the rules above. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && rankableIssue(p) === null;
}

/** The snapshot's 758-protocol accounting, computed from the snapshot itself. */
export interface Ledger {
  total: number;
  token_record: number;
  ranked: number;
  excluded_category: number;
  wrapped_name: number;
  exchange_name: number;
  versioned_name: number;
}

export function ledgerOf(snapshot: Snapshot): Ledger {
  const ledger: Ledger = { total: snapshot.protocols.length, token_record: 0, ranked: 0, excluded_category: 0, wrapped_name: 0, exchange_name: 0, versioned_name: 0 };
  for (const p of snapshot.protocols) {
    if (hasTokenRecord(p)) {
      ledger.token_record++;
      continue;
    }
    const issue = rankableIssue(p);
    if (issue === null) ledger.ranked++;
    else if (issue === 'excluded-category') ledger.excluded_category++;
    else if (issue === 'wrapped-name') ledger.wrapped_name++;
    else if (issue === 'exchange-name') ledger.exchange_name++;
    else ledger.versioned_name++;
  }
  return ledger;
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ---------------------------------------------------------------- value model

/** The traded comps the value curve is fitted on: a token trades, no CEX, sane multiple. */
export function compsOf(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => {
    if (p.mcap_usd === null || p.tvl_usd <= 0 || p.category === 'CEX') return false;
    const r = p.mcap_usd / p.tvl_usd;
    return r >= 0.02 && r <= 10;
  });
}

/** One rung of the value-model ablation ladder. */
export type ValueKind = 'flat' | 'curve' | 'family' | 'full';

/** A fitted value model: a log-value predictor plus its fitted pieces, for display. */
export interface ValueFit {
  predict: (p: SnapshotProtocol) => number;
  curve: { a: number; b: number };
  flatMedian: number;
  offsets: Record<string, { n: number; median: number; shrunk: number }>;
}

/**
 * Fit one rung on `train`. flat is the median mcap/TVL multiple; curve is the
 * L1 log-log line; family adds unshrunk per-family median residual offsets;
 * full shrinks those offsets by n/(n+8).
 */
export function fitValue(train: SnapshotProtocol[], kind: ValueKind): ValueFit {
  const xs = train.map((p) => Math.log(p.tvl_usd));
  const ys = train.map((p) => Math.log(p.mcap_usd!));
  const flatMedian = median(ys.map((y, i) => y - xs[i]!));
  const curve = l1Fit(xs, ys);
  const byFamily = new Map<Family, number[]>();
  train.forEach((p, i) => {
    const f = familyOf(p);
    const arr = byFamily.get(f) ?? [];
    arr.push(ys[i]! - (curve.a + curve.b * xs[i]!));
    byFamily.set(f, arr);
  });
  const offsets: Record<string, { n: number; median: number; shrunk: number }> = {};
  for (const f of FAMILIES) {
    const arr = byFamily.get(f) ?? [];
    const med = arr.length > 0 ? median(arr) : 0;
    offsets[f] = { n: arr.length, median: med, shrunk: arr.length > 0 ? (arr.length / (arr.length + SHRINK_K)) * med : 0 };
  }
  const predict = (p: SnapshotProtocol): number => {
    const x = Math.log(p.tvl_usd);
    if (kind === 'flat') return x + flatMedian;
    const base = curve.a + curve.b * x;
    if (kind === 'curve') return base;
    const off = offsets[familyOf(p)]!;
    return base + (kind === 'family' ? off.median : off.shrunk);
  };
  return { predict, curve, flatMedian, offsets };
}

/** How a value model scores on a test set: median miss, share within 3x, Spearman. */
export interface ValueScore {
  median_miss: number;
  within_3x: number;
  spearman: number;
  n: number;
}

export function scoreValue(predict: (p: SnapshotProtocol) => number, test: SnapshotProtocol[]): ValueScore {
  const misses = test.map((p) => Math.abs(Math.log(p.mcap_usd!) - predict(p)));
  const actual = test.map((p) => Math.log(p.mcap_usd!));
  const predicted = test.map((p) => predict(p));
  return {
    median_miss: median(misses.map((m) => Math.exp(m))),
    within_3x: misses.filter((m) => Math.exp(m) <= 3).length / misses.length,
    spearman: spearman(actual, predicted),
    n: test.length,
  };
}

/** Leave-one-out scores for every rung, on the comps. */
export function looValue(comps: SnapshotProtocol[]): Record<ValueKind, ValueScore> {
  const out = {} as Record<ValueKind, ValueScore>;
  for (const kind of ['flat', 'curve', 'family', 'full'] as ValueKind[]) {
    const preds = comps.map((p, i) => fitValue(comps.filter((_, j) => j !== i), kind).predict(p));
    out[kind] = scoreValue((p) => preds[comps.indexOf(p)]!, comps);
  }
  return out;
}

/**
 * Walk-forward scores: fit on the older half of the dated comps, test on the
 * newer half. The honest out-of-sample test — the model never sees the future.
 */
export function walkForwardValue(comps: SnapshotProtocol[], asOf: string): { train_n: number; test_n: number; scores: Record<ValueKind, ValueScore> } {
  const dated = comps.filter((p) => ageDays(asOf, p.listed_at) !== null).sort((a, b) => ageDays(asOf, b.listed_at)! - ageDays(asOf, a.listed_at)!);
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const scores = {} as Record<ValueKind, ValueScore>;
  for (const kind of ['flat', 'curve', 'family', 'full'] as ValueKind[]) {
    scores[kind] = scoreValue(fitValue(train, kind).predict, test);
  }
  return { train_n: train.length, test_n: test.length, scores };
}

/** The full model's leave-one-out log-residuals, for honest bands. */
export function looResiduals(comps: SnapshotProtocol[]): number[] {
  return comps.map((p, i) => Math.log(p.mcap_usd!) - fitValue(comps.filter((_, j) => j !== i), 'full').predict(p));
}

/** Band factors from residual quantiles: point x factor. */
export interface BandFactors {
  p10: number;
  p25: number;
  p75: number;
  p90: number;
}

export function bandFactors(residuals: number[]): BandFactors {
  return {
    p10: Math.exp(quantile(residuals, 0.1)),
    p25: Math.exp(quantile(residuals, 0.25)),
    p75: Math.exp(quantile(residuals, 0.75)),
    p90: Math.exp(quantile(residuals, 0.9)),
  };
}

/**
 * Walk-forward band coverage: calibrate the residual quantiles on the older
 * half's own leave-one-out residuals, then measure coverage on the newer half.
 */
export function walkForwardBandCoverage(comps: SnapshotProtocol[], asOf: string): { n: number; p50: number; p80: number } {
  const dated = comps.filter((p) => ageDays(asOf, p.listed_at) !== null).sort((a, b) => ageDays(asOf, b.listed_at)! - ageDays(asOf, a.listed_at)!);
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const trainRes = train.map((p, i) => Math.log(p.mcap_usd!) - fitValue(train.filter((_, j) => j !== i), 'full').predict(p));
  const q25 = quantile(trainRes, 0.25);
  const q75 = quantile(trainRes, 0.75);
  const q10 = quantile(trainRes, 0.1);
  const q90 = quantile(trainRes, 0.9);
  const predict = fitValue(train, 'full').predict;
  let c50 = 0;
  let c80 = 0;
  for (const p of test) {
    const r = Math.log(p.mcap_usd!) - predict(p);
    if (r >= q25 && r <= q75) c50++;
    if (r >= q10 && r <= q90) c80++;
  }
  return { n: test.length, p50: c50 / test.length, p80: c80 / test.length };
}

// ---------------------------------------------------------------- odds model

/** The odds peer set: protocols listed at least a year by the snapshot date. */
export function peersOf(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => {
    const a = ageDays(snapshot.as_of, p.listed_at);
    return a !== null && a >= 365;
  });
}

/** Family dummy positions in the odds design (Other is the reference). */
const ODDS_FAMILY_INDEX: Record<string, number> = { Lending: 0, Trading: 1, 'Vaults & yield': 2, RWA: 3, Staking: 4, Infra: 5 };

/** One odds design row: [1, age_years, family dummies...], plus extras by mode. */
export function oddsDesign(p: SnapshotProtocol, asOf: string, mode: 'age' | 'age-family' | 'age-family-tvl' | 'age-family-chg'): number[] {
  const age = (ageDays(asOf, p.listed_at) ?? 365) / 365;
  const row = [1, age];
  if (mode !== 'age') {
    const dummies = [0, 0, 0, 0, 0, 0];
    const fi = ODDS_FAMILY_INDEX[familyOf(p)];
    if (fi !== undefined) dummies[fi] = 1;
    row.push(...dummies);
  }
  if (mode === 'age-family-tvl') row.push(Math.log(p.tvl_usd) - 18);
  if (mode === 'age-family-chg') row.push((p.change_7d ?? 0) / 100);
  return row;
}

/**
 * Logistic regression by Newton-Raphson (IRLS) with a ridge penalty on every
 * coefficient but the intercept. Deterministic; converges in a few steps.
 */
export function logitFit(rows: [number[], number][], lambda = ODDS_LAMBDA, iters = 100): number[] {
  const k = rows[0]![0].length;
  let beta = new Array<number>(k).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array<number>(k).fill(0);
    const h = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (const [x, y] of rows) {
      const z = x.reduce((s, v, j) => s + v * beta[j]!, 0);
      const mu = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const w = Math.max(mu * (1 - mu), 1e-6);
      for (let j = 0; j < k; j++) {
        g[j]! += (y - mu) * x[j]!;
        for (let l = 0; l < k; l++) h[j]![l]! += w * x[j]! * x[l]!;
      }
    }
    for (let j = 1; j < k; j++) {
      g[j]! -= lambda * beta[j]!;
      h[j]![j]! += lambda;
    }
    const delta = solveLinear(h, g);
    let maxd = 0;
    for (let j = 0; j < k; j++) {
      beta[j]! += delta[j]!;
      maxd = Math.max(maxd, Math.abs(delta[j]!));
    }
    if (maxd < 1e-9) break;
  }
  return beta;
}

/** P(token) for one protocol under fitted betas. */
export function oddsProb(beta: number[], p: SnapshotProtocol, asOf: string, mode: 'age' | 'age-family' | 'age-family-tvl' | 'age-family-chg' = 'age-family'): number {
  const x = oddsDesign(p, asOf, mode);
  const z = x.reduce((s, v, j) => s + v * beta[j]!, 0);
  return 1 / (1 + Math.exp(-z));
}

/** Mean squared error of probabilities against outcomes. */
export function brierScore(beta: number[], set: SnapshotProtocol[], asOf: string, mode: 'age' | 'age-family' | 'age-family-tvl' | 'age-family-chg' = 'age-family'): number {
  let s = 0;
  for (const p of set) {
    const d = oddsProb(beta, p, asOf, mode) - (hasTokenRecord(p) ? 1 : 0);
    s += d * d;
  }
  return s / set.length;
}

/** 10-fold cross-validated Brier (deterministic folds: slug order, index mod 10). */
export function cvBrier(peers: SnapshotProtocol[], asOf: string, mode: 'age' | 'age-family' | 'age-family-tvl' | 'age-family-chg'): number {
  const sorted = [...peers].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  let sum = 0;
  for (let f = 0; f < 10; f++) {
    const test = sorted.filter((_, i) => i % 10 === f);
    const train = sorted.filter((_, i) => i % 10 !== f);
    const beta = logitFit(train.map((p) => [oddsDesign(p, asOf, mode), hasTokenRecord(p) ? 1 : 0] as [number[], number]));
    sum += brierScore(beta, test, asOf, mode) * test.length;
  }
  return sum / peers.length;
}

/**
 * Walk-forward odds: fit on the older half of the peers, test on the newer
 * half. The honest baseline is the train token rate carried forward — the
 * test set's own rate would leak test information.
 */
export function walkForwardOdds(peers: SnapshotProtocol[], asOf: string): { train_n: number; test_n: number; train_rate: number; test_rate: number; brier: number; baseline: number } {
  const dated = [...peers].sort((a, b) => ageDays(asOf, b.listed_at)! - ageDays(asOf, a.listed_at)!);
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const beta = logitFit(train.map((p) => [oddsDesign(p, asOf, 'age-family'), hasTokenRecord(p) ? 1 : 0] as [number[], number]));
  const trainRate = train.filter(hasTokenRecord).length / train.length;
  let base = 0;
  for (const p of test) {
    const d = trainRate - (hasTokenRecord(p) ? 1 : 0);
    base += d * d;
  }
  return {
    train_n: train.length,
    test_n: test.length,
    train_rate: trainRate,
    test_rate: test.filter(hasTokenRecord).length / test.length,
    brier: brierScore(beta, test, asOf),
    baseline: base / test.length,
  };
}

// ---------------------------------------------------------------- farm economics

/** Gas per transaction in USD by chain (stated assumptions, not snapshot data). Covers every first chain the board's protocols name; anything else defaults to $3. */
const GAS_PER_TX: Record<string, number> = {
  Ethereum: 15,
  Bitcoin: 5,
  Tron: 3,
  Arbitrum: 2,
  Avalanche: 2,
  Bittensor: 2,
  BSquared: 2,
  Mezo: 2,
  RSK: 2,
  Stacks: 2,
  Base: 1,
  Polygon: 1,
  Binance: 1,
  BNB: 1,
  Mantle: 1,
  'Robinhood Chain': 1,
  Monad: 1,
  Berachain: 1,
  Flare: 1,
  Arc: 1,
  RISE: 1,
  Manta: 1,
  Ink: 1,
  Morph: 1,
  'Plume Mainnet': 1,
  Plasma: 1,
  Pharos: 1,
  'World Chain': 1,
  'Reya Network': 1,
  Strato: 1,
  Klaytn: 1,
  'zkSync Era': 1,
  zkSync: 1,
  Canton: 1,
  Tempo: 1,
  Stable: 1,
  Fluent: 1,
  Starknet: 1,
  Optimism: 2,
  Fantom: 1,
  Linea: 1,
  Scroll: 1,
  Mode: 1,
  Blast: 1,
  Gnosis: 1,
  Celo: 1,
  Kava: 1,
  Cronos: 1,
  Moonbeam: 1,
  Harmony: 1,
  Hyperliquid: 1,
  MegaETH: 1,
  'Arbitrum Nova': 1,
  Metis: 1,
  Zora: 1,
  opBNB: 1,
  'Bitcoin Layer2': 2,
  Merlin: 2,
  B2: 2,
  Bitlayer: 2,
  BOB: 2,
  Botanix: 2,
  Core: 1,
  Hemi: 1,
  Soneium: 1,
  Abstract: 1,
  Gravity: 1,
  XLayer: 1,
  Lisk: 1,
  Superseed: 1,
  Corn: 1,
  Sonic: 1,
  Katana: 1,
  Solana: 0.5,
  Sui: 0.5,
  Aptos: 0.5,
  Sei: 0.5,
  Algorand: 0.5,
  Stellar: 0.5,
  Ripple: 0.5,
  'Bifrost Network': 0.5,
  'Hyperliquid L1': 0.5,
  Provenance: 0.5,
  Ronin: 0.5,
  Proton: 0.5,
  Noble: 0.5,
  Qubic: 0.5,
  XION: 0.5,
  Near: 0.5,
  Cosmos: 0.5,
  Osmosis: 0.5,
  Injective: 0.5,
};

/** Gas per transaction for a protocol's first chain, default $3. */
export function gasPerTx(p: SnapshotProtocol): number {
  const chain = p.chains.length > 0 ? p.chains[0]! : '';
  return GAS_PER_TX[chain] ?? 3;
}

/** Hours one farm plan takes: setup + weekly attention over the hold + claim. */
export function farmHours(): number {
  return (SETUP_MINUTES + CLAIM_MINUTES + (HOLD_DAYS / 7) * WEEKLY_MINUTES) / 60;
}

export type Verdict = 'FARM' | 'MARGINAL' | 'SKIP';

/** The $1,000 standard plan's economics for one row. */
export interface RowEconomics {
  gas_usd: number;
  forgone_usd: number;
  slice_usd: number;
  slice_if_launches_usd: number;
  net_usd: number;
  hourly_usd: number;
  tbill_hurdle_usd: number;
  breakeven_implied_usd: number;
  pays_from_deposit_usd: number | null;
  verdict: Verdict;
}

/**
 * The standard plan, at the odds-weighted implied value: the airdrop is 10%
 * of the token's value, your share is your deposit's share of TVL, costs are
 * gas plus 4% forgone yield over the 90-day hold. Break-even is the implied
 * value at which the net is zero; pays-from is the deposit at which it is.
 */
export function economicsFor(impliedUsd: number, valueIfLaunchesUsd: number, tvlUsd: number, gasUsd: number, depositUsd = DEPOSIT_USD): RowEconomics {
  const forgone = depositUsd * FORGONE_APR * (HOLD_DAYS / 365);
  const slice = AIRDROP_SHARE * impliedUsd * (depositUsd / tvlUsd);
  const sliceIfLaunches = AIRDROP_SHARE * valueIfLaunchesUsd * (depositUsd / tvlUsd);
  const net = slice - gasUsd - forgone;
  const hours = farmHours();
  const tbillHurdle = depositUsd * TBILL_APR * (HOLD_DAYS / 365);
  const breakeven = ((gasUsd + forgone) * tvlUsd) / (AIRDROP_SHARE * depositUsd);
  const marginalPerDollar = (AIRDROP_SHARE * impliedUsd) / tvlUsd - FORGONE_APR * (HOLD_DAYS / 365);
  const paysFrom = marginalPerDollar > 0 ? gasUsd / marginalPerDollar : null;
  const verdict: Verdict = net > tbillHurdle && net / hours >= HOURLY_HURDLE_USD ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
  return {
    gas_usd: gasUsd,
    forgone_usd: forgone,
    slice_usd: slice,
    slice_if_launches_usd: sliceIfLaunches,
    net_usd: net,
    hourly_usd: net / hours,
    tbill_hurdle_usd: tbillHurdle,
    breakeven_implied_usd: breakeven,
    pays_from_deposit_usd: paysFrom,
    verdict,
  };
}

// ---------------------------------------------------------------- farm plans

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: action, then cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and re-check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's one action, in words a farmer can follow, at the $1,000 standard deposit. */
function actionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $1,000 of USDC into ${name} on ${chain} and leave the supply position open.`;
  if (c.includes('dex') || c.includes('liquidity manager')) return `Add $1,000 of liquidity to ${name}'s deepest pool on ${chain} and leave the position open.`;
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('farm') || c.includes('curator') || c.includes('allocator') || c.includes('index')) return `Deposit $1,000 into a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('bridge')) return `Bridge $1,000 of USDC through ${name} onto ${chain} and use the bridged funds in its app.`;
  if (c.includes('stak') || c.includes('restak')) return `Stake $1,000 through ${name} on ${chain} and keep the staking receipt.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis') || c.includes('synthetic') || c.includes('option')) return `Deposit $1,000 of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $1,000 on ${name} and take one small position in an active market.`;
  if (c.includes('stable') || c.includes('rwa') || c.includes('reserve')) return `Mint or buy $1,000 of the asset ${name} issues on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $1,000 of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('launchpad')) return `Stake $1,000 through ${name}'s launchpad on ${chain} to qualify for allocations.`;
  if (c.includes('chain')) return `Bridge $1,000 onto ${name} and use one native app on the chain.`;
  if (c.includes('privacy')) return `Deposit $1,000 through ${name}'s private pool on ${chain} and keep the note.`;
  if (c.includes('payment')) return `Route $1,000 of payments through ${name} on ${chain} over the hold.`;
  if (c.includes('nft') || c.includes('marketplace')) return `List or buy $1,000 of volume through ${name} on ${chain} and keep the receipts.`;
  if (c.includes('locker')) return `Lock $1,000 of tokens through ${name} on ${chain} for the hold period.`;
  if (c.includes('ai') || c.includes('agent')) return `Deposit $1,000 into ${name}'s agent pool on ${chain} and keep the position.`;
  return `Deposit $1,000 of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * Derived from the protocol's own record (category, chains, gas), never from
 * a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, econ: RowEconomics): FarmStep[] {
  const chain = chainOf(p);
  const gas = `$${econ.gas_usd.toFixed(2)}`;
  return [
    {
      text: `Set up a fresh wallet holding only the $1,000 you plan to farm, and store its seed phrase offline.`,
      cost: 'nothing to create, gas starts with the first transaction',
      time: '10 minutes',
    },
    {
      text: actionFor(p, chain),
      cost: `$1,000 of capital plus about ${gas} of gas for the plan's transactions`,
      time: '20 minutes to set up',
    },
    {
      text: `Do one qualifying action a week — a deposit, a borrow, a swap or a vote — so the wallet stays active.`,
      cost: 'about $1 of gas a week on ' + chain,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for the full ${HOLD_DAYS}-day window so the activity lands in more than one snapshot.`,
      cost: `the $1,000 stays in the position, about $${econ.forgone_usd.toFixed(2)} of forgone yield`,
      time: `${HOLD_DAYS} days`,
    },
    {
      text: `Before withdrawing, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay anyone to claim',
      time: '15 minutes',
    },
    {
      text: `Log the wallet, the dates and every transaction hash so you can repeat the position or unwind it cleanly.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ---------------------------------------------------------------- board

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  family: Family;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  value_if_launches_usd: number;
  token_odds: number;
  implied_value_usd: number;
  band_p25_usd: number;
  band_p75_usd: number;
  band_p10_usd: number;
  band_p90_usd: number;
  verdict: Verdict;
  economics: RowEconomics;
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  family: Family;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  value_if_launches_usd: number;
  token_odds: number;
  implied_value_usd: number;
  band_p25_usd: number;
  band_p75_usd: number;
  band_p10_usd: number;
  band_p90_usd: number;
  verdict: Verdict;
  gas_usd: number;
  slice_usd: number;
  net_usd: number;
  hourly_usd: number;
  breakeven_implied_usd: number;
  pays_from_deposit_usd: number | null;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Every measured number the dashboard's evidence panels show. */
export interface ModelEvidence {
  comps_n: number;
  peers_n: number;
  peer_token_rate: number;
  curve: { a: number; b: number };
  offsets: Record<string, { n: number; median: number; shrunk: number }>;
  loo: Record<ValueKind, ValueScore>;
  walk_forward: { train_n: number; test_n: number; scores: Record<ValueKind, ValueScore> };
  bands: BandFactors;
  band_coverage_wf: { n: number; p50: number; p80: number };
  odds_betas: number[];
  odds_brier_cv: number;
  odds_brier_base: number;
  odds_walk_forward: { train_n: number; test_n: number; train_rate: number; test_rate: number; brier: number; baseline: number };
  odds_ablation: { age: number; age_family: number; age_family_tvl: number; age_family_chg: number };
  ledger: Ledger;
  verdicts: { FARM: number; MARGINAL: number; SKIP: number };
  board_total_implied_usd: number;
  board_total_value_usd: number;
  economics: { deposit_usd: number; hold_days: number; forgone_apr: number; tbill_apr: number; airdrop_share: number; hourly_hurdle_usd: number; farm_hours: number; farm_txs: number };
}

/** Everything the dashboard needs: the board, the live set, and the evidence. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  evidence: ModelEvidence;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => hasTokenRecord(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, 24)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; evidence: ModelEvidence } {
  const comps = compsOf(snapshot);
  const peers = peersOf(snapshot);
  const valueFit = fitValue(comps, 'full');
  const oddsBeta = logitFit(peers.map((p) => [oddsDesign(p, snapshot.as_of, 'age-family'), hasTokenRecord(p) ? 1 : 0] as [number[], number]));
  const bands = bandFactors(looResiduals(comps));

  const chosen = snapshot.protocols.filter(isRankable);
  const scored = chosen.map((p) => {
    const value = Math.exp(valueFit.predict(p));
    const odds = oddsProb(oddsBeta, p, snapshot.as_of);
    const implied = Math.max(1, Math.round(value * odds));
    const gas = gasPerTx(p) * FARM_TXS;
    const econ = economicsFor(implied, Math.round(value), p.tvl_usd, gas);
    return { p, value: Math.round(value), odds, implied, econ };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const verdicts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  const board: BoardRow[] = scored.map((s, i) => {
    verdicts[s.econ.verdict]++;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      family: familyOf(s.p),
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: ageDays(snapshot.as_of, s.p.listed_at),
      value_if_launches_usd: s.value,
      token_odds: round4(s.odds),
      implied_value_usd: s.implied,
      band_p25_usd: Math.max(1, Math.round(s.value * bands.p25 * s.odds)),
      band_p75_usd: Math.max(1, Math.round(s.value * bands.p75 * s.odds)),
      band_p10_usd: Math.max(1, Math.round(s.value * bands.p10 * s.odds)),
      band_p90_usd: Math.max(1, Math.round(s.value * bands.p90 * s.odds)),
      verdict: s.econ.verdict,
      economics: {
        gas_usd: round2(s.econ.gas_usd),
        forgone_usd: round2(s.econ.forgone_usd),
        slice_usd: round2(s.econ.slice_usd),
        slice_if_launches_usd: round2(s.econ.slice_if_launches_usd),
        net_usd: round2(s.econ.net_usd),
        hourly_usd: round2(s.econ.hourly_usd),
        tbill_hurdle_usd: round2(s.econ.tbill_hurdle_usd),
        breakeven_implied_usd: Math.round(s.econ.breakeven_implied_usd),
        pays_from_deposit_usd: s.econ.pays_from_deposit_usd === null ? null : Math.round(s.econ.pays_from_deposit_usd),
        verdict: s.econ.verdict,
      },
      farm_steps: farmSteps(s.p, s.econ).map(stepText),
    };
  });

  const loo = looValue(comps);
  const wf = walkForwardValue(comps, snapshot.as_of);
  const wfBands = walkForwardBandCoverage(comps, snapshot.as_of);
  const wfOdds = walkForwardOdds(peers, snapshot.as_of);
  const peerRate = peers.filter(hasTokenRecord).length / peers.length;
  const evidence: ModelEvidence = {
    comps_n: comps.length,
    peers_n: peers.length,
    peer_token_rate: round4(peerRate),
    curve: { a: round4(valueFit.curve.a), b: round4(valueFit.curve.b) },
    offsets: Object.fromEntries(
      Object.entries(valueFit.offsets).map(([f, o]) => [f, { n: o.n, median: round4(o.median), shrunk: round4(o.shrunk) }]),
    ),
    loo,
    walk_forward: wf,
    bands: { p10: round4(bands.p10), p25: round4(bands.p25), p75: round4(bands.p75), p90: round4(bands.p90) },
    band_coverage_wf: { n: wfBands.n, p50: round4(wfBands.p50), p80: round4(wfBands.p80) },
    odds_betas: oddsBeta.map(round4),
    odds_brier_cv: round4(cvBrier(peers, snapshot.as_of, 'age-family')),
    odds_brier_base: round4(peerRate * (1 - peerRate)),
    odds_walk_forward: {
      train_n: wfOdds.train_n,
      test_n: wfOdds.test_n,
      train_rate: round4(wfOdds.train_rate),
      test_rate: round4(wfOdds.test_rate),
      brier: round4(wfOdds.brier),
      baseline: round4(wfOdds.baseline),
    },
    odds_ablation: {
      age: round4(cvBrier(peers, snapshot.as_of, 'age')),
      age_family: round4(cvBrier(peers, snapshot.as_of, 'age-family')),
      age_family_tvl: round4(cvBrier(peers, snapshot.as_of, 'age-family-tvl')),
      age_family_chg: round4(cvBrier(peers, snapshot.as_of, 'age-family-chg')),
    },
    ledger: ledgerOf(snapshot),
    verdicts,
    board_total_implied_usd: board.reduce((s, r) => s + r.implied_value_usd, 0),
    board_total_value_usd: board.reduce((s, r) => s + r.value_if_launches_usd, 0),
    economics: {
      deposit_usd: DEPOSIT_USD,
      hold_days: HOLD_DAYS,
      forgone_apr: FORGONE_APR,
      tbill_apr: TBILL_APR,
      airdrop_share: AIRDROP_SHARE,
      hourly_hurdle_usd: HOURLY_HURDLE_USD,
      farm_hours: round2(farmHours()),
      farm_txs: FARM_TXS,
    },
  };
  return { board, evidence };
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    family: row.family,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    value_if_launches_usd: row.value_if_launches_usd,
    token_odds: row.token_odds,
    implied_value_usd: row.implied_value_usd,
    band_p25_usd: row.band_p25_usd,
    band_p75_usd: row.band_p75_usd,
    band_p10_usd: row.band_p10_usd,
    band_p90_usd: row.band_p90_usd,
    verdict: row.verdict,
    gas_usd: row.economics.gas_usd,
    slice_usd: row.economics.slice_usd,
    net_usd: row.economics.net_usd,
    hourly_usd: row.economics.hourly_usd,
    breakeven_implied_usd: row.economics.breakeven_implied_usd,
    pays_from_deposit_usd: row.economics.pays_from_deposit_usd,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { board, evidence } = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
    evidence,
  };
  return { board, radar };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
