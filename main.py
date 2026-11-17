"""Dip-bounce mean-reversion bot for cbBTC (agent-fun/bars-replay/v1).

Strategy, tuned on the kit's frozen 24h dev window (1,440 one-minute bars):

  1. Buy only when the close is >= 0.6% below the 120-bar SMA of closes,
     AND the close is above the previous bar's close (the bounce has
     started; no catching a falling knife mid-drop).
  2. Sell the whole position when the close climbs back to >= 0.4% above
     the same SMA, or when it falls >= 1.5% below the entry close.
  3. One position, full size, long only. No leverage, no shorts.

Why this and not an EMA cross: on 1-minute bars BTC whipsaws, and an
EMA(8)/EMA(21) cross trades ~42 times in 24h while every round trip pays
~26-38 bps in fee + slippage + pool impact, so it ends about -$18.50 on
the dev window. The dip-buy trades 4 round trips and nets about +$14.61
in the same simulator, with a 0.96% max drawdown (buy-and-hold: +$1.07,
2.12% drawdown). Costs are the whole game at this size, so trade rarely.

Determinism: only the bars drive decisions. Closes are kept as the
integers the harness sends (price scale 5); the SMA is a float over a
fixed window in a fixed order, so the same bars always give the same
orders. No clock, no environment, no randomness, no network, no files.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
import makefun_bars

SYMBOL = "CBBTC"

# --- strategy parameters (fractions, tuned on the dev window) ---
SMA_BARS = 120        # lookback of the moving average, in bars
DIP = 0.006           # buy when close <= SMA * (1 - DIP)
BOUNCE_EXIT = 0.004   # sell when close >= SMA * (1 + BOUNCE_EXIT)
STOP_LOSS = 0.015     # sell when close <= entry * (1 - STOP_LOSS)
MAX_SLIPPAGE_BPS = 200  # 2%: far above any 1-minute move, guards only against absurd fills

# --- state, rebuilt from the bars as they arrive ---
closes = []           # closes seen so far, newest last (ints, price scale 5)
entry_close = None    # close the current position was decided at, else None


def on_batch(state, batch):
    global entry_close
    close = state.close(SYMBOL)
    if close is None:
        return []
    prev = closes[-1] if closes else None
    closes.append(close)

    # Warm-up batches build history only: any order on one is rejected.
    if state.warming_up:
        return []

    holding = state.positions.get(SYMBOL)
    if holding is not None and holding.qty > 0:
        # --- exit: bounce taken, or stop-loss hit ---
        sma = sum(closes[-SMA_BARS:]) / min(len(closes), SMA_BARS)
        stop_hit = entry_close is not None and close <= entry_close * (1 - STOP_LOSS)
        if close >= sma * (1 + BOUNCE_EXIT) or stop_hit:
            entry_close = None
            return [{
                "side": "sell",
                "symbol": SYMBOL,
                "qty": holding.qty,
                "max_slippage_bps": MAX_SLIPPAGE_BPS,
            }]
        return []

    # No position (a sell just filled, or never bought): clear the entry.
    entry_close = None

    # --- entry: dip below the average, with the bounce already ticking up ---
    if len(closes) < SMA_BARS:
        return []
    sma = sum(closes[-SMA_BARS:]) / SMA_BARS
    if close > sma * (1 - DIP):
        return []
    if prev is None or close <= prev:
        return []

    notional = min(state.cash, state.weight_room(SYMBOL))
    if notional < state.hello["fees"]["min_notional_quote_units"]:
        return []
    entry_close = close
    return [{
        "side": "buy",
        "symbol": SYMBOL,
        "notional_quote_units": notional,
        "max_slippage_bps": MAX_SLIPPAGE_BPS,
    }]


makefun_bars.run(on_batch)
