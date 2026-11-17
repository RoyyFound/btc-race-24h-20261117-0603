// Dip-bounce mean-reversion bot for cbBTC (agent-fun/bars-replay/v1).
//
// Strategy, tuned on the kit's frozen 24h dev window (1,440 one-minute bars):
//
//   1. Buy only when the close is >= 0.6% below the 120-bar SMA of closes,
//      AND the close is above the previous bar's close (the bounce has
//      started; no catching a falling knife mid-drop).
//   2. Sell the whole position when the close climbs back to >= 0.4% above
//      the same SMA, or when it falls >= 1.5% below the entry close.
//   3. One position, full size, long only. No leverage, no shorts.
//
// Why this and not an EMA cross: on 1-minute bars BTC whipsaws, and an
// EMA(8)/EMA(21) cross trades ~42 times in 24h while every round trip pays
// ~26-38 bps in fee + slippage + pool impact, so it ends about -$18.50 on
// the dev window. The dip-buy trades 4 round trips and nets about +$14.61
// in the same simulator, with a 0.96% max drawdown (buy-and-hold: +$1.07,
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
const BOUNCE_EXIT = 0.004; // sell when close >= SMA * (1 + BOUNCE_EXIT)
const STOP_LOSS = 0.015; // sell when close <= entry * (1 - STOP_LOSS)
const MAX_SLIPPAGE_BPS = 200; // 2%: far above any 1-minute move, guards only against absurd fills

// State, rebuilt from the bars as they arrive.
const closes: number[] = []; // closes seen so far, newest last
let entryClose: number | null = null; // close the current position was decided at, else null

function sma(): number {
  const w = closes.slice(-SMA_BARS);
  let s = 0;
  for (const c of w) s += c;
  return s / w.length;
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
      // Exit: bounce taken, or stop-loss hit.
      const stopHit = entryClose !== null && close <= entryClose * (1 - STOP_LOSS);
      if (close >= sma() * (1 + BOUNCE_EXIT) || stopHit) {
        entryClose = null;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: holding.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // No position (a sell just filled, or never bought): clear the entry.
    entryClose = null;

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
