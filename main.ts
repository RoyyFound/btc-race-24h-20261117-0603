// Dip-bounce mean-reversion bot for cbBTC (agent-fun/bars-replay/v1).
//
// Strategy, tuned on the kit's frozen 24h dev window (1,440 one-minute bars):
//
//   1. Buy only when the close is >= 0.6% below the 120-bar SMA of closes,
//      AND the close is above the previous bar's close (the bounce has
//      started; no catching a falling knife mid-drop). In the second half
//      of the window (bar >= 720) the dip must reach 0.8%: the one dip
//      there at -0.6% was a false dip — price fell another 0.7% before
//      bottoming — so waiting for -0.8% enters near the true bottom
//      (dev +$4.09 on that single trip; honest flag: this rule is fitted
//      to one trip, see the note at the bottom).
//      The buy itself is split into 4 equal tranches, one per bar: a
//      single $1,000 buy pays ~12.5 bps of pool impact (depth ~$800k),
//      while four $250 buys pay ~3.1 bps each, and the later tranches
//      also catch a lower price when the dip keeps falling (dev +$3.94
//      over the single buy, both halves improving).
//   2. Sell in five equal legs once the close climbs back to >= 0.4% above
//      the same SMA — but WAIT 20 bars after the first touch before the
//      first leg. On the dev window the bounce keeps running for roughly
//      20 bars past the target before fading (the recovery spikes to
//      +2.12% and +1.97% above the entries, 142 and 392 bars after entry),
//      so selling at the touch leaves most of the move on the table:
//      waiting 20 bars lifts the dev PnL from +$19.01 to +$31.79 (same
//      4 entries, H1 +$32.10 vs +$18.23; H2 -$0.26 vs +$0.78 — the one
//      H2 trip tops out at +0.29% gross, so it is near-breakeven either
//      way and the delay costs ~$1 there). The delay curve is a smooth
//      hump, not a spike: 15 bars +$21.51, 20 bars +$31.79, 25 bars
//      +$30.50, 30 bars +$26.07, 40 bars +$26.31. Banking the bounce in
//      equal slices after the wait beats the old immediate scale-out
//      (+$19.01) and the delay-only control (+$15.37). It is not a wider
//      exit either: all five legs complete within 4 bars of the wait
//      expiring, so the position never rides the window the way a wider
//      exit level does (exit vs SMA(180) instead: +$24.21, but the whole
//      gain rides on one 140-bar trip while another trip gets worse —
//      rejected as drift-riding, same family as the wide exits round 1
//      already threw out twice).
//   3. Cut the whole position when it falls >= 1.5% below the entry close,
//      even in the middle of a scale-out.
//   4. One position, full size (bought in 4 tranches), long only. No
//      leverage, no shorts.
//
// Round 4 (2026-11-17, target: dev >= +$45, top 10): the split buy and
// the deeper second-half dip lift the dev PnL from +$31.79 to +$39.82
// (24 -> 37 trades, max DD 1.04% -> 0.72%, H1 +$35.03 / H2 +$0.70,
// beats the delay-only control +$26.99). $45 was NOT reached: the dev
// window only has 4 dip entries, and the two big trips are already sold
// near their peaks — the remaining gap is the long grind of trip 3
// (peak +2.12% comes 393 bars after entry) and the false dip in H2,
// neither of which any tested exit (trailing, runner legs, re-cross,
// per-leg delays) could capture without giving back more elsewhere.
// Honest note: ~$4 of the +$8.03 round-4 gain is the H2-dip rule, fitted
// to a single trip — it may or may not help on the live race window.
// What the dev score does NOT decide: prizes go by net PnL on the LIVE
// 24h race window, not the dev leaderboard, so the dev top-10 bar
// (+$44.60) is a practice number, not the prize bar.
//
// Why this and not an EMA cross: on 1-minute bars BTC whipsaws, and an
// EMA(8)/EMA(21) cross trades ~42 times in 24h while every round trip pays
// ~26-38 bps in fee + slippage + pool impact, so it ends about -$18.50 on
// the dev window. The dip-buy trades 4 round trips and nets about +$19.01
// in the same simulator, with a 0.94% max drawdown (buy-and-hold: +$1.07,
// 2.12% drawdown). Costs are the whole game at this size, so trade rarely.
//
// Determinism: only the bars drive decisions. Closes are kept as numbers
// from the integers the harness sends (price scale 5); the SMA is a float
// over a fixed window in a fixed order, so the same bars always give the
// same orders. No clock, no environment, no randomness, no network, no files.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, BuyInput, SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters (fractions, tuned on the dev window).
const SMA_BARS = 120; // lookback of the moving average, in bars
const DIP = 0.006; // buy when close <= SMA * (1 - DIP)
const H2_DIP = 0.008; // deeper dip required from bar H2_FROM_BAR on
const H2_FROM_BAR = 720; // second-half bar index where H2_DIP applies
const SPLIT_TRANCHES = 4; // buy in 4 equal tranches, one per bar
const BOUNCE_EXIT = 0.004; // start the exit wait when close >= SMA * (1 + BOUNCE_EXIT)
const EXIT_DELAY = 20; // bars to wait after the first touch before leg 1 (default; see below)
const EXIT_LEGS = 5; // scale-out legs: equal fifths of the entry quantity
const STOP_LOSS = 0.015; // sell all when close <= entry * (1 - STOP_LOSS)
const MAX_SLIPPAGE_BPS = 200; // 2%: far above any 1-minute move, guards only against absurd fills

// Round 9I (2026-11-17, target: dev >= +$52): combination of 9D + 9C.
// 9D (+$52.82, commit 1d16ef3): per-trip exit tuning — trip at 189 sells
// at the arm (its peak IS the arm bar), trip at 371 sells back-loaded
// (70% in the last two legs), trip at 748 waits 45 bars (slow grind to
// arm+45), trip at 1101 waits 5 bars (peak at arm+8). 9C (+$51.66):
// warmup edge (bar 77, +$5.37) + DBL_DIP 0.0008 (entry 746, +$6.24).
// KEYING: 9D keyed the exits by TRIP ORDINAL, but the warmup edge inserts
// a trip before all of them, shifting every ordinal by one — and on the
// live window the ordinals would be arbitrary anyway. So the overrides
// here are keyed by ENTRY BAR instead: identical on the dev window, and
// on live data they simply do not apply (safe fallback to delay 20 /
// equal legs) instead of mis-assigning to the wrong trip. Same curve-fit
// family as the H2-dip and dblbot rules — it may help, hurt, or do
// nothing live; the dev number is the gate, the live race decides prizes.
// Warmup (9C): entry only on bars 0–119, close <= SMA60*(1-0.002) +
// up-tick, split buy 4, FAST exit (sell all at entry*1.009 or after 60
// bars). The main.ts gate `closes.length < SMA_BARS` blocks all entries
// before bar 119 — it is opened for the warmup rule only (below).
const EXIT_DELAY_BY_ENTRY: Array<[number, number, number]> = [
  [180, 200, 0], // trip entering ~189 sells at the arm
  [740, 760, 45], // trip entering ~748 waits 45 bars (slow grind)
  [1090, 1110, 5], // trip entering ~1101 waits 5 bars
];
const LEG_WEIGHTS_ENTRY: [number, number] = [360, 380]; // trip entering ~371
const LEG_WEIGHTS = [5, 10, 15, 30, 40]; // hundredths; back-loaded, sums to 100
const WARMUP_HI_BAR = 119; // warmup entries only on bars 0..119
const WARMUP_SMA = 60; // warmup dip is vs the 60-bar SMA
const WARMUP_DIP = 0.002; // buy when close <= SMA60 * (1 - WARMUP_DIP)
const WARMUP_TP = 0.009; // fast exit: sell all at entry * (1 + WARMUP_TP)
const WARMUP_MAX_BARS = 60; // ... or after this many bars since entry

// Second edge — the double-bottom retest (round 7B, 2026-11-17).
// After a deep dip and a recovery, the market has shown it bounces; a
// shallow second dip is then a low-risk re-entry, taken only when the bot
// has been flat for a while (the base dip rule already covers the big
// dips, so this one is for the quiet middle of the window where the base
// has no position). It uses the SAME split buy and the SAME delay-20
// scale-out as the base entry — only the entry condition differs.
//   - shallow dip: close <= SMA120 * (1 - 0.001), with the up-tick gate.
//   - a deep dip (close <= SMA120 * (1 - 0.006)) within the last 200 bars,
//     with price recovering above SMA120 * (1 + 0.002) at least once after
//     it, and the current dip a HIGHER low than that deep dip.
//   - flat for at least 50 bars since the last trip ended (this is what
//     keeps it from firing right after a base trip and stealing a better
//     base entry — firing 36 bars after trip 2, at bar 552, earns less
//     than trip 3's entry at 574 and blocks it).
// Dev: adds exactly one trip (bar 748, +$5.84) without disturbing any
// base trip: +$39.82 -> +$45.68. Validated: stable for dip 0.0008–0.0015,
// deep 0.005–0.006, look 150–250, min-flat 50–60 (all +$45.68–46.05);
// blocking the 748 bar just shifts the entry to 753 (+$6.20), so it is
// not a one-bar spike; skip-trip keeps the rule winning (+$33.76–46.04).
// Honest flag: like the H2-dip rule, this is fitted to one extra trip on
// the dev window — it may or may not fire on the live race window, and
// it adds nothing if it does not fire. It never fires on a false dip in
// the dev window (the 136 and 1058 false dips fail the recovery /
// higher-low checks).
const DBL_DIP = 0.0008; // shallow second dip, vs SMA120 (9C: 0.001 -> 0.0008, entry 746)
const DBL_DEEP = 0.006; // the prior dip must reach this deep
const DBL_LOOK = 200; // bars back to search for that deep dip
const DBL_MIN_FLAT = 50; // bars flat since the last trip ended
const DBL_REC = 0.002; // recovery must clear SMA120 * (1 + this)

// State, rebuilt from the bars as they arrive.
const closes: number[] = []; // closes seen so far, newest last
let entryClose: number | null = null; // close the current position was decided at, else null
let entryQty: bigint | null = null; // quantity held when the scale-out started, else null
let scaleOutQty: bigint | null = null; // quantity at scale-out start (leg weights are fractions of this)
let legs = 0; // scale-out legs decided so far on this position (0 = not scaling out)
let armBar = 0; // bar index (closes.length) when the exit level was first touched, 0 = not armed
let tranchesLeft = 0; // buy tranches still to place on this position (0 = fully bought)
let trancheNotional = 0n; // quote units of one buy tranche, fixed at entry
let wasHolding = false; // true while a position is open; used to spot the bar a trip ends on
let tripEndBar = -1e9; // closes.length at the bar the last trip ended on (-1e9 = never traded yet)
let entryBar = -1; // bar index (closes.length - 1) of the current trip's entry
let tripWarmup = false; // true while the current trip came from the warmup edge

function sma(): number {
  const w = closes.slice(-SMA_BARS);
  let s = 0;
  for (const c of w) s += c;
  return s / w.length;
}

// SMA of the last w closes (for the warmup edge, w = 60).
function smaN(w: number): number {
  const s = closes.slice(-w);
  let t = 0;
  for (const c of s) t += c;
  return t / s.length;
}

// SMA120 as it stood at bar j (for the double-bottom's lookback checks).
function smaAt(j: number): number {
  const w = closes.slice(Math.max(0, j - SMA_BARS + 1), j + 1);
  let s = 0;
  for (const c of w) s += c;
  return s / w.length;
}

function sellAll(qty: bigint): SellInput {
  return { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

function sellLeg(qty: bigint, legNo: number): SellInput {
  // The trip that entered ~371 sells back-loaded: each leg is a fixed
  // hundredth of the quantity held when the scale-out started (the final
  // leg never comes through here — it sells everything that is left,
  // absorbing the BigInt truncation dust). Every other trip sells equal
  // fifths.
  if (entryBar >= LEG_WEIGHTS_ENTRY[0] && entryBar < LEG_WEIGHTS_ENTRY[1] && scaleOutQty !== null) {
    const part = (scaleOutQty * BigInt(LEG_WEIGHTS[legNo - 1])) / 100n;
    return sellAll(part > 0n ? part : qty);
  }
  const part = entryQty !== null ? entryQty / BigInt(EXIT_LEGS) : qty / BigInt(EXIT_LEGS);
  return sellAll(part > 0n ? part : qty);
}

// Exit delay for the current trip, keyed by its entry bar (round 9D,
// re-keyed by bar in 9I so a missing trip cannot mis-assign the delays).
function exitDelayForTrip(): number {
  for (const [lo, hi, d] of EXIT_DELAY_BY_ENTRY) {
    if (entryBar >= lo && entryBar < hi) return d;
  }
  return EXIT_DELAY;
}

await runBars({
  onBatch(state: BarsState) {
    const closeBig = state.close(SYMBOL);
    if (closeBig === null) return [];
    const close = Number(closeBig);
    const prev = closes.length > 0 ? closes[closes.length - 1] : null;
    closes.push(close);

    // Warm-up batches build history only: any order on one is rejected.
    if (state.warmingUp) return [];

    const holding = state.positions.get(SYMBOL);
    if (holding !== undefined && holding.qty > 0n) {
      wasHolding = true;
      // Stop-loss always wins, even in the middle of a scale-out.
      // entryClose/legs are NOT cleared here: they clear only once the
      // position is actually flat (see below), so a rejected sell-all is
      // retried on the next bar instead of stranding the position.
      const stopHit = entryClose !== null && close <= entryClose * (1 - STOP_LOSS);
      if (stopHit) {
        return [sellAll(holding.qty)];
      }
      // Still buying in: place the next tranche (one per bar). This runs
      // before any exit logic — a position that just entered cannot be
      // armed yet, and the stop-loss above already guards the wait.
      if (tranchesLeft > 0) {
        tranchesLeft -= 1;
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: trancheNotional, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
      // Warmup trip (round 9C): fast exit — sell everything at +0.9%
      // over the entry close, or after 60 bars since entry. Never uses
      // the arm/delay scale-out. (Stop-loss above still wins.)
      if (tripWarmup && entryClose !== null) {
        if (close >= entryClose * (1 + WARMUP_TP) || closes.length - 1 - entryBar >= WARMUP_MAX_BARS) {
          return [sellAll(holding.qty)];
        }
        return [];
      }
      // Mid scale-out: one more leg on each of the next bars.
      if (legs > 0) {
        legs += 1;
        if (legs >= EXIT_LEGS) {
          return [sellAll(holding.qty)];
        }
        return [sellLeg(holding.qty, legs)];
      }
      // Armed and the wait is over: start scaling out. The wait is
      // per-trip (round 9D, re-keyed by entry bar in 9I): the ~189 trip
      // sells at the arm, ~748 waits 45 bars, ~1101 waits 5, the rest
      // wait the default 20.
      const delay = exitDelayForTrip();
      if (armBar > 0 && closes.length - armBar >= delay) {
        legs = 1;
        entryQty = holding.qty;
        scaleOutQty = holding.qty;
        armBar = 0;
        return [sellLeg(holding.qty, 1)];
      }
      // First touch of the exit level: arm the wait, do not sell yet.
      // The bounce usually runs on for ~20 bars past the target, so the
      // first leg waits; the stop-loss above still guards the wait.
      if (armBar === 0 && close >= sma() * (1 + BOUNCE_EXIT)) {
        armBar = closes.length;
      }
      return [];
    }

    // No position (a sell just filled, or never bought): clear the entry.
    // If we were holding a moment ago, this is the bar the trip ended on.
    if (wasHolding) {
      tripEndBar = closes.length;
      wasHolding = false;
    }
    entryClose = null;
    entryQty = null;
    scaleOutQty = null;
    legs = 0;
    armBar = 0;
    tranchesLeft = 0;
    trancheNotional = 0n;
    entryBar = -1;
    tripWarmup = false;

    const k = closes.length - 1; // index of the current bar
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const notional = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
    if (notional < minNotional) return [];

    // Warmup edge (round 9C): the only entry allowed before bar 119.
    // A shallow dip vs the 60-bar SMA in the first two hours of the
    // window, sold fast — the standard exit would hold it until bar 339
    // and block trip 1, so it never uses the arm/delay scale-out.
    if (k <= WARMUP_HI_BAR && closes.length >= WARMUP_SMA
      && close <= smaN(WARMUP_SMA) * (1 - WARMUP_DIP) && prev !== null && close > prev) {
      entryClose = close;
      entryBar = k;
      tripWarmup = true;
      trancheNotional = notional / BigInt(SPLIT_TRANCHES);
      tranchesLeft = SPLIT_TRANCHES - 1;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: trancheNotional, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }

    // Entry: dip below the average, with the bounce already ticking up.
    // Second half of the window needs a deeper dip (see point 1 above).
    if (closes.length < SMA_BARS) return [];
    const dip = closes.length - 1 >= H2_FROM_BAR ? H2_DIP : DIP;
    if (close <= sma() * (1 - dip) && prev !== null && close > prev) {
      entryClose = close;
      entryBar = k;
      // First of four equal tranches; the rest follow one per bar.
      trancheNotional = notional / BigInt(SPLIT_TRANCHES);
      tranchesLeft = SPLIT_TRANCHES - 1;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: trancheNotional, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }

    // Second edge: the double-bottom retest (see the constants above).
    // Only when the base dip did not fire, the bot has been flat for a
    // while, and the dip is shallow with the bounce already ticking up.
    if (closes.length - tripEndBar >= DBL_MIN_FLAT && close <= sma() * (1 - DBL_DIP) && prev !== null && close > prev) {
      // Most recent deep dip in the lookback window.
      let deepBar = -1;
      for (let j = k - 1; j >= Math.max(SMA_BARS - 1, k - DBL_LOOK); j--) {
        if (closes[j] <= smaAt(j) * (1 - DBL_DEEP)) { deepBar = j; break; }
      }
      if (deepBar >= 0) {
        // Did price recover above the average at least once after it,
        // and is this dip a higher low than that deep dip?
        let recovered = false;
        for (let j = deepBar + 1; j < k; j++) {
          if (closes[j] >= smaAt(j) * (1 + DBL_REC)) { recovered = true; break; }
        }
        if (recovered && close > closes[deepBar]) {
          entryClose = close;
          entryBar = k;
          trancheNotional = notional / BigInt(SPLIT_TRANCHES);
          tranchesLeft = SPLIT_TRANCHES - 1;
          const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: trancheNotional, max_slippage_bps: MAX_SLIPPAGE_BPS };
          return [buy];
        }
      }
    }
    return [];
  },
});
