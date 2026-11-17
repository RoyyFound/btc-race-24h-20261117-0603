// Dip-bounce mean-reversion bot for cbBTC (agent-fun/bars-replay/v1).
//
// Strategy, tuned on the kit's frozen 24h dev window (1,440 one-minute bars):
//
//   1. Buy only when the close is >= 0.6% below the 120-bar SMA of closes,
//      AND the close is above the previous bar's close (the bounce has
//      started; no catching a falling knife mid-drop).
//   2. Sell in five equal legs once the close climbs back to >= 0.4% above
//      the same SMA: a fifth of the position at the first touch, then a fifth
//      on each of the next four bars. Banking the bounce in equal slices
//      beats the old three geometric legs on the dev window (same 4 entries,
//      +$19.01 vs +$18.37, both halves better: H1 +$18.23 vs +$17.79, H2
//      +$0.78 vs +$0.58, max drawdown 0.94% vs 0.96%), and it is a flat
//      plateau, not a tuned spike: 4, 5, 6, 7 and 8 equal legs all land
//      between +$18.92 and +$19.07, and every one of them beats the
//      delay-only control (sell everything at the second touch: +$15.37).
//      It is not a wider exit either: all five legs complete within 4 bars
//      of the touch, so the position never rides the window the way a wider
//      exit level does (exit vs SMA(180) instead: +$24.21, but the whole
//      gain rides on one 140-bar trip while another trip gets worse —
//      rejected as drift-riding, same family as the wide exits round 1
//      already threw out twice).
//   3. Cut the whole position when it falls >= 1.5% below the entry close,
//      even in the middle of a scale-out.
//   4. One position, full size, long only. No leverage, no shorts.
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
const BOUNCE_EXIT = 0.004; // start selling when close >= SMA * (1 + BOUNCE_EXIT)
const EXIT_LEGS = 5; // scale-out legs: equal fifths of the entry quantity
const STOP_LOSS = 0.015; // sell all when close <= entry * (1 - STOP_LOSS)
const MAX_SLIPPAGE_BPS = 200; // 2%: far above any 1-minute move, guards only against absurd fills

// State, rebuilt from the bars as they arrive.
const closes: number[] = []; // closes seen so far, newest last
let entryClose: number | null = null; // close the current position was decided at, else null
let entryQty: bigint | null = null; // quantity held when the scale-out started, else null
let legs = 0; // scale-out legs decided so far on this position (0 = not scaling out)

function sma(): number {
  const w = closes.slice(-SMA_BARS);
  let s = 0;
  for (const c of w) s += c;
  return s / w.length;
}

function sellAll(qty: bigint): SellInput {
  return { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

function sellFifth(qty: bigint): SellInput {
  // One equal leg: a fifth of the quantity held when the scale-out started
  // (not of what is left, so the legs are equal slices, not shrinking
  // ones). Never zero while a position is open, so the order is never
  // rejected as zero_amount; the final leg sells everything that is left,
  // which also absorbs the BigInt truncation dust.
  const part = entryQty !== null ? entryQty / BigInt(EXIT_LEGS) : qty / BigInt(EXIT_LEGS);
  return sellAll(part > 0n ? part : qty);
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
      // Stop-loss always wins, even in the middle of a scale-out.
      // entryClose/legs are NOT cleared here: they clear only once the
      // position is actually flat (see below), so a rejected sell-all is
      // retried on the next bar instead of stranding the position.
      const stopHit = entryClose !== null && close <= entryClose * (1 - STOP_LOSS);
      if (stopHit) {
        return [sellAll(holding.qty)];
      }
      // Mid scale-out: one more leg on each of the next bars.
      if (legs > 0) {
        legs += 1;
        if (legs >= EXIT_LEGS) {
          return [sellAll(holding.qty)];
        }
        return [sellFifth(holding.qty)];
      }
      // First touch of the exit level: start scaling out.
      if (close >= sma() * (1 + BOUNCE_EXIT)) {
        legs = 1;
        entryQty = holding.qty;
        return [sellFifth(holding.qty)];
      }
      return [];
    }

    // No position (a sell just filled, or never bought): clear the entry.
    entryClose = null;
    entryQty = null;
    legs = 0;

    // Entry: dip below the average, with the bounce already ticking up.
    if (closes.length < SMA_BARS) return [];
    if (close > sma() * (1 - DIP)) return [];
    if (prev === null || close <= prev) return [];

    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const notional = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
    if (notional < minNotional) return [];
    entryClose = close;
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
