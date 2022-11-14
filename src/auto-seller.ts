#!ts-node

import { AccountInfo, Context, Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import * as schedule from "node-schedule";
import { Market, Orderbook as SerumOrderbook, MARKETS } from "@project-serum/serum";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import ccxt from "ccxt";
import { assert, dateStr, getWeighted } from "./utils";

let cnt = 0;
let markPrice: number = undefined;
let serumBidPrice: number = undefined;
let lowestSerumPrice: number = undefined;

async function subscribeToBinanceBids(symbol: string, orderbookDepth: number): Promise<void> {
  // validate exchanges
  const exchange = new ccxt.pro.binance();
  await exchange.loadMarkets();

  while (true) {
    const orderbook = await exchange.watchOrderBook(symbol);
    const bidsWeighted = getWeighted(orderbook.bids, orderbookDepth);
    const asksWeighted = getWeighted(orderbook.asks, orderbookDepth);

    if (bidsWeighted.bestPrice == null) {
      markPrice = undefined;
      console.log(`Binance orderbook not deep enough, totalBidSize: ${bidsWeighted.totalSize}, totalAskSize: ${asksWeighted.totalSize}`);
    } else {
      const currMarkPrice = (bidsWeighted.weightedPrice + asksWeighted.weightedPrice) / 2;
      if (markPrice == undefined || currMarkPrice != markPrice) {
        markPrice = currMarkPrice;
        console.log(`Binance ${symbol} weighted mark: ${markPrice}`);
      }
    }
  }
}

export async function subscribeToSerumMarkets(symbol: string, market: Market, connection: Connection, orderbookDepth: number): Promise<void> {
  const registerCallback = (market: Market) => async (accountInfoUpdate: AccountInfo<Buffer>, _: Context) => {
    const l2Orders = SerumOrderbook.decode(market, accountInfoUpdate.data).getL2(100);
    const { weightedPrice, totalSize, bestPrice } = getWeighted(
      l2Orders.map(([price, size]) => [price, size]),
      orderbookDepth
    );

    if (weightedPrice == undefined) {
      serumBidPrice = undefined;
      console.log(`Serum orderbook bids not deep enough, totalBidSize: ${totalSize}`);
    } else {
      if (serumBidPrice == undefined || weightedPrice != serumBidPrice) {
        serumBidPrice = weightedPrice;
        lowestSerumPrice = bestPrice;
        console.log(`Serum ${symbol} weighted bid: ${serumBidPrice}`);
      }
    }
  };

  connection.onAccountChange(market.bidsAddress, registerCallback(market));
}

export async function sell(
  connection: Connection,
  market: Market,
  ownerWallet: Keypair,
  openOrdersAddressKey: PublicKey,
  amount: number,
  allowedDivergence: number,
  floorThreshold: number,
  strategy: `utilize-divergence` | `disregard-divergence` = `utilize-divergence`
) {
  const sellPrice = lowestSerumPrice;
  const actDivergence = serumBidPrice / markPrice;
  if (
    markPrice == undefined ||
    serumBidPrice == undefined ||
    sellPrice == undefined ||
    serumBidPrice < floorThreshold ||
    (strategy == `utilize-divergence` && actDivergence < allowedDivergence)
  ) {
    console.log(
      `...skipping trade due to unfavourable market conditions: markPrice: ${markPrice}, serumBidPrice: ${serumBidPrice}, sellPrice: ${sellPrice}, actDivergence ${actDivergence}, allowedDivergence: ${allowedDivergence}, floorThreshold: ${floorThreshold}`
    );
  } else {
    const t0 = new Date();
    console.log(
      `${dateStr(t0)}: ${cnt}: start of sale of ${amount} @ ${sellPrice} USDC, favourable conditions: markPrice ${markPrice}, serumBidPrice: ${serumBidPrice}`
    );

    try {
      const baseWallet = (market as any).baseWallet;
      const quoteWallet = (market as any).quoteWallet;

      const transaction = new Transaction();
      transaction.add(
        market.makeNewOrderV3Instruction({
          owner: ownerWallet.publicKey,
          payer: baseWallet,
          side: `sell`,
          price: sellPrice,
          size: amount,
          orderType: `limit`,
          openOrdersAddressKey,
          selfTradeBehavior: `abortTransaction`,
        })
      );
      transaction.add(market.settleFundsIx(ownerWallet.publicKey, openOrdersAddressKey, baseWallet, quoteWallet));
      await sendAndConfirmTransaction(connection, transaction, [ownerWallet], { commitment: `processed`, skipPreflight: true });

      const t1 = new Date();
      console.log(`${dateStr(t1)}: ${cnt}: sell of ${amount} @ ${sellPrice} performed in ${t1.getTime() - t0.getTime()}ms`);
    } catch (e) {
      const t1 = new Date();
      console.log(`${dateStr(t1)}: ${cnt}: transaction failed after ${t1.getTime() - t0.getTime()}m!`);
      console.log(e);
    } finally {
      cnt += 1;
    }
  }
}

const config = require(`../config.json`);

async function main() {
  console.log(`Setup as per config:
- connectionUrl:        ${config.connectionUrl}
- openOrdersAddressKey: ${config.openOrdersAddressKey}
- tradeAmount:          ${config.tradeAmount},
- binanceMarkSymbol:    ${config.binanceMarkSymbol}
- serumTradeSymbol:     ${config.serumTradeSymbol}
- allowedDivergence:    ${config.allowedDivergence}
- floorThreshold:       ${config.floorThreshold}
- strategy:             ${config.strategy}
`);
  assert(config.connectionUrl != undefined, `connectionUrl undefined`);
  assert(config.openOrdersAddressKey != undefined, `openOrdersAddressKey undefined`);
  assert(config.serumTradeSymbol != undefined, `serumTradeSymbol undefined`);
  assert(config.serumTradeSymbol != undefined, `serumTradeSymbol undefined`);
  assert(config.binanceMarkSymbol != undefined, `binanceMarkSymbol undefined`);
  assert(config.tradeAmount > 0, `tradeAmount too low`);
  assert(config.floorThreshold > 0, `floorThreshold too low`);

  const connection: Connection = new Connection(config.connectionUrl, `processed`);
  const ownerWallet = Keypair.fromSecretKey(Buffer.from(config.ownerWallet));
  const openOrdersAddress = new PublicKey(config.openOrdersAddressKey);
  const marketInfo = MARKETS.filter((x) => !x.deprecated && x.name == config.serumTradeSymbol)[0];
  console.log(`Market load...`);
  const market: Market = await Market.load(connection, marketInfo.address, { skipPreflight: true, commitment: `processed` }, marketInfo.programId);
  (market as any).baseWallet = await getAssociatedTokenAddress(market.baseMintAddress, ownerWallet.publicKey);
  (market as any).quoteWallet = await getAssociatedTokenAddress(market.quoteMintAddress, ownerWallet.publicKey);
  console.log(`Subscribing to binance orderbook...`);
  subscribeToBinanceBids(config.binanceMarkSymbol, config.tradeAmount);
  console.log(`Subscribing to serum orderbook...`);
  subscribeToSerumMarkets(config.serumTradeSymbol, market, connection, config.tradeAmount);
  console.log(`Setup done...`);

  // let the prices settle and make 1 test trade
  // await new Promise((f) => setTimeout(f, 10000));
  // await sell(connection, market, wallet, openOrdersAddress, config.tradeAmount, config.allowedDivergence, config.floorThreshold, config.strategy);
  // process.exit(1);

  // run the server and updater
  schedule.scheduleJob(
    `0/${config.intervalSecs} * * * * *`,
    async () =>
      await sell(connection, market, ownerWallet, openOrdersAddress, config.tradeAmount, config.allowedDivergence, config.floorThreshold, config.strategy)
  );
}

main();
