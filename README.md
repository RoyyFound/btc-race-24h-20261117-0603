# Dip-Bounce cbBTC Bot

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A mean-reversion bot for Coinbase Wrapped BTC (cbBTC) on Solana, built by an AI agent for make.fun's "Race a BTC trading bot live for 24 hours" bounty, $250 in USDC.

## Strategy

Bitcoin on 1-minute bars spends most of its time wiggling sideways; sharp
dips below the recent average tend to bounce back, and chasing every EMA
cross just pays the 26+ bps round-trip cost over and over. So this bot does
one thing, patiently:

1. **Wait for a dip.** Buy only when the close is at least 0.6% below the
   120-bar simple moving average of closes.
2. **Wait for the bounce to start.** The dip alone is not enough: the close
   must also be above the previous bar's close (an up-tick), so we do not
   catch a falling knife mid-drop.
3. **Take the bounce, don't marry it.** Sell the whole position when the
   close climbs back to 0.4% above the same 120-bar average, or cut it at
   1.5% below the entry price, whichever comes first.
4. **One position, full size.** Long only, at most one open position, sized
   to the full cash balance, because a $1,000 account cannot afford to
   dribble: every fill pays a fixed fee + slippage + pool impact, so half
   sizes just halve the gains while the costs stay proportional.

No network, no wall clock, no files outside the repo, no randomness: the
same bars always produce the same orders. Only the Node 22 standard library
is used, plus the kit's own `vendor/makefun-bars.ts` shim (a byte-identical
copy of the kit SDK).

## Backtest (dev window, 1,440 one-minute bars)

Measured with a local simulator that replicates the replay's fill model
(fill at the next bar's open, 4 bps fee, 2 bps slippage, constant-product
price impact against the bar's open depth):

| Strategy | Net PnL | Trades | Max drawdown |
|---|---|---|---|
| Buy-and-hold (baseline) | +$1.07 | 1 | 2.12% |
| EMA(8)/EMA(21) cross | -$18.51 | 42 | 2.02% |
| Dip-buy SMA(120), no gate | +$12.98 | 8 | 0.99% |
| **Dip-buy + bounce gate (this bot)** | **+$14.61** | **8** | **0.96%** |

The EMA-cross loses because 1-minute BTC whipsaws: it trades 42 times and
the ~26–38 bps round-trip cost eats every small win. The dip-buy trades
only 4 round trips in 24 hours and each one clears the cost by a wide
margin.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1`: newline-delimited JSON on stdin
and stdout, one reply per batch. Grade it locally with the kit:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=aroyy&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
