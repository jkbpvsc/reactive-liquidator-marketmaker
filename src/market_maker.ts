import {Account, Commitment, Connection, PublicKey, Transaction, TransactionInstruction,} from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import {BN} from 'bn.js';
import {
    BookSide,
    BookSideLayout,
    Cluster,
    Config,
    getMultipleAccounts,
    getPerpMarketByBaseSymbol,
    GroupConfig,
    IDS,
    makeCancelAllPerpOrdersInstruction,
    makePlacePerpOrderInstruction,
    MangoAccount,
    MangoAccountLayout,
    MangoCache,
    MangoCacheLayout,
    MangoClient,
    MangoGroup,
    ONE_BN,
    PerpMarket,
    PerpMarketConfig,
    sleep,
    zeroKey,
} from '@blockworks-foundation/mango-client';
import {OpenOrders} from '@project-serum/serum';
import path from 'path';
import {MM_PARAMS} from "./config";
import {BotContext} from "./john-wayne";

export function startSmoking(ctx: BotContext) {
    if (control.isRunning) {
        fullMarketMaker(ctx).finally(() => startSmoking(ctx));
    }
}

async function fullMarketMaker(ctx: BotContext) {
    const connection = ctx.connection;
    const client = ctx.client;

    // load mangoAccount
    let mangoAccount: MangoAccount = ctx.account;

    const marketContexts: MarketContext[] = [];
    for (const baseSymbol in MM_PARAMS.assets) {
        const perpMarketConfig = getPerpMarketByBaseSymbol(
            ctx.groupConfig,
            baseSymbol,
        ) as PerpMarketConfig;
        const perpMarket = await client.getPerpMarket(
            perpMarketConfig.publicKey,
            perpMarketConfig.baseDecimals,
            perpMarketConfig.quoteDecimals,
        );
        marketContexts.push({
            marketName: perpMarketConfig.name,
            params: MM_PARAMS.assets[baseSymbol].perp,
            config: perpMarketConfig,
            market: perpMarket,
            marketIndex: perpMarketConfig.marketIndex,
            bids: await perpMarket.loadBids(connection),
            asks: await perpMarket.loadAsks(connection),
        });
    }

    process.on('SIGINT', function () {
        console.log('Caught keyboard interrupt. Canceling orders');
        control.isRunning = false;
        onExit(ctx, marketContexts);
    });

    while (control.isRunning) {
        try {
            const state = await loadAccountAndMarketState(
                ctx,
                marketContexts,
            );
            mangoAccount = state.mangoAccount;

            let j = 0;
            let tx = new Transaction();
            const txProms: any[] = [];
            for (let i = 0; i < marketContexts.length; i++) {
                const instrSet = makeMarketUpdateInstructions(
                    ctx,
                    marketContexts[i],
                );

                if (instrSet.length > 0) {
                    instrSet.forEach((ix) => tx.add(ix));
                    j++;
                    if (j === MM_PARAMS.batch) {
                        txProms.push(client.sendTransaction(tx, ctx.payer, []));
                        tx = new Transaction();
                        j = 0;
                    }
                }
            }
            if (tx.instructions.length) {
                txProms.push(client.sendTransaction(tx, ctx.payer, []));
            }
            if (txProms.length) {
                const txids = await Promise.all(txProms);
                txids.forEach((txid) => console.log(`success ${txid.toString()}`));
            }
        } catch (e) {
            console.log(e);
        } finally {
            console.log(
                `${new Date().toUTCString()} sleeping for ${control.interval / 1000}s`,
            );
            await sleep(control.interval);
        }
    }
}

const control = {
    isRunning: true,
    interval: MM_PARAMS.interval
};

type MarketContext = {
    marketName: string;
    params: any;
    config: PerpMarketConfig;
    market: PerpMarket;
    marketIndex: number;
    bids: BookSide;
    asks: BookSide;
};

/**
 * Load MangoCache, MangoAccount and Bids and Asks for all PerpMarkets using only
 * one RPC call.
 */
async function loadAccountAndMarketState(
    ctx: BotContext,
    marketContexts: MarketContext[],
): Promise<{
    cache: MangoCache;
    mangoAccount: MangoAccount;
    marketContexts: MarketContext[];
}> {
    const {
        group,
        account,
        connection,
    } = ctx;

    const inBasketOpenOrders = account
        .getOpenOrdersKeysInBasket()
        .filter((pk) => !pk.equals(zeroKey));

    const allAccounts = [
        group.mangoCache,
        account.publicKey,
        ...inBasketOpenOrders,
        ...marketContexts.map((marketContext) => marketContext.market.bids),
        ...marketContexts.map((marketContext) => marketContext.market.asks),
    ];

    const accountInfos = await getMultipleAccounts(connection, allAccounts);

    const cache = new MangoCache(
        accountInfos[0].publicKey,
        MangoCacheLayout.decode(accountInfos[0].accountInfo.data),
    );

    const mangoAccount = new MangoAccount(
        accountInfos[1].publicKey,
        MangoAccountLayout.decode(accountInfos[1].accountInfo.data),
    );
    const openOrdersAis = accountInfos.slice(2, 2 + inBasketOpenOrders.length);
    for (let i = 0; i < openOrdersAis.length; i++) {
        const ai = openOrdersAis[i];
        const marketIndex = mangoAccount.spotOpenOrders.findIndex((soo) =>
            soo.equals(ai.publicKey),
        );
        mangoAccount.spotOpenOrdersAccounts[marketIndex] =
            OpenOrders.fromAccountInfo(
                ai.publicKey,
                ai.accountInfo,
                group.dexProgramId,
            );
    }

    accountInfos
        .slice(
            2 + inBasketOpenOrders.length,
            2 + inBasketOpenOrders.length + marketContexts.length,
        )
        .forEach((ai, i) => {
            marketContexts[i].bids = new BookSide(
                ai.publicKey,
                marketContexts[i].market,
                BookSideLayout.decode(ai.accountInfo.data),
            );
        });

    accountInfos
        .slice(
            2 + inBasketOpenOrders.length + marketContexts.length,
            2 + inBasketOpenOrders.length + 2 * marketContexts.length,
        )
        .forEach((ai, i) => {
            marketContexts[i].asks = new BookSide(
                ai.publicKey,
                marketContexts[i].market,
                BookSideLayout.decode(ai.accountInfo.data),
            );
        });

    return {
        cache,
        mangoAccount,
        marketContexts,
    };
}

function makeMarketUpdateInstructions(
    ctx: BotContext,
    marketContext: MarketContext,
): TransactionInstruction[] {

    const {
        group,
        account,
        cache,
        payer,
    } = ctx;

    const mangoProgramId = ctx.groupConfig.mangoProgramId;

    // Right now only uses the perp
    const marketIndex = marketContext.marketIndex;
    const market = marketContext.market;
    const bids = marketContext.bids;
    const asks = marketContext.asks;
    const fairValue = group.getPrice(marketIndex, cache).toNumber();
    const equity = account.computeValue(group, cache).toNumber();
    const perpAccount = account.perpAccounts[marketIndex];
    // TODO look at event queue as well for unprocessed fills
    const basePos = perpAccount.getBasePositionUi(market);

    const sizePerc = marketContext.params.sizePerc;
    const leanCoeff = marketContext.params.leanCoeff;
    const charge = marketContext.params.charge;
    const bias = marketContext.params.bias;
    const requoteThresh = marketContext.params.requoteThresh;
    const takeSpammers = marketContext.params.takeSpammers;
    const spammerCharge = marketContext.params.spammerCharge;
    const size = (equity * sizePerc) / fairValue;
    const lean = (-leanCoeff * basePos) / size;
    const bidPrice = fairValue * (1 - charge + lean + bias);
    const askPrice = fairValue * (1 + charge + lean + bias);

    const [modelBidPrice, nativeBidSize] = market.uiToNativePriceQuantity(
        bidPrice,
        size,
    );
    const [modelAskPrice, nativeAskSize] = market.uiToNativePriceQuantity(
        askPrice,
        size,
    );

    const bestBid = bids.getBest();
    const bestAsk = asks.getBest();
    const bookAdjBid =
        bestAsk !== undefined
            ? BN.min(bestAsk.priceLots.sub(ONE_BN), modelBidPrice)
            : modelBidPrice;
    const bookAdjAsk =
        bestBid !== undefined
            ? BN.max(bestBid.priceLots.add(ONE_BN), modelAskPrice)
            : modelAskPrice;

    // TODO use order book to requote if size has changed
    const openOrders = account
        .getPerpOpenOrders()
        .filter((o) => o.marketIndex === marketIndex);
    let moveOrders = openOrders.length === 0 || openOrders.length > 2;
    for (const o of openOrders) {
        console.log(
            `${o.side} ${o.price.toString()} -> ${
                o.side === 'buy' ? bookAdjBid.toString() : bookAdjAsk.toString()
            }`,
        );

        if (o.side === 'buy') {
            if (
                Math.abs(o.price.toNumber() / bookAdjBid.toNumber() - 1) > requoteThresh
            ) {
                moveOrders = true;
            }
        } else {
            if (
                Math.abs(o.price.toNumber() / bookAdjAsk.toNumber() - 1) > requoteThresh
            ) {
                moveOrders = true;
            }
        }
    }

    // Start building the transaction
    const instructions: TransactionInstruction[] = [];
    /*
    Clear 1 lot size orders at the top of book that bad people use to manipulate the price
     */
    if (
        takeSpammers &&
        bestBid !== undefined &&
        bestBid.sizeLots.eq(ONE_BN) &&
        bestBid.priceLots.toNumber() / modelAskPrice.toNumber() - 1 >
        spammerCharge * charge + 0.0005
    ) {
        console.log(`${marketContext.marketName} taking best bid spammer`);
        const takerSell = makePlacePerpOrderInstruction(
            mangoProgramId,
            group.publicKey,
            account.publicKey,
            payer.publicKey,
            cache.publicKey,
            market.publicKey,
            market.bids,
            market.asks,
            market.eventQueue,
            account.getOpenOrdersKeysInBasket(),
            bestBid.priceLots,
            ONE_BN,
            new BN(Date.now()),
            'sell',
            'ioc',
        );
        instructions.push(takerSell);
    } else if (
        takeSpammers &&
        bestAsk !== undefined &&
        bestAsk.sizeLots.eq(ONE_BN) &&
        modelBidPrice.toNumber() / bestAsk.priceLots.toNumber() - 1 >
        spammerCharge * charge + 0.0005
    ) {
        console.log(`${marketContext.marketName} taking best ask spammer`);
        const takerBuy = makePlacePerpOrderInstruction(
            mangoProgramId,
            group.publicKey,
            account.publicKey,
            payer.publicKey,
            cache.publicKey,
            market.publicKey,
            market.bids,
            market.asks,
            market.eventQueue,
            account.getOpenOrdersKeysInBasket(),
            bestAsk.priceLots,
            ONE_BN,
            new BN(Date.now()),
            'buy',
            'ioc',
        );
        instructions.push(takerBuy);
    }
    if (moveOrders) {
        // cancel all, requote
        const cancelAllInstr = makeCancelAllPerpOrdersInstruction(
            mangoProgramId,
            group.publicKey,
            account.publicKey,
            payer.publicKey,
            market.publicKey,
            market.bids,
            market.asks,
            new BN(20),
        );

        const placeBidInstr = makePlacePerpOrderInstruction(
            mangoProgramId,
            group.publicKey,
            account.publicKey,
            payer.publicKey,
            cache.publicKey,
            market.publicKey,
            market.bids,
            market.asks,
            market.eventQueue,
            account.getOpenOrdersKeysInBasket(),
            bookAdjBid,
            nativeBidSize,
            new BN(Date.now()),
            'buy',
            'postOnlySlide',
        );

        const placeAskInstr = makePlacePerpOrderInstruction(
            mangoProgramId,
            group.publicKey,
            account.publicKey,
            payer.publicKey,
            cache.publicKey,
            market.publicKey,
            market.bids,
            market.asks,
            market.eventQueue,
            account.getOpenOrdersKeysInBasket(),
            bookAdjAsk,
            nativeAskSize,
            new BN(Date.now()),
            'sell',
            'postOnlySlide',
        );
        instructions.push(cancelAllInstr);
        instructions.push(placeBidInstr);
        instructions.push(placeAskInstr);
    } else {
        console.log(
            `${marketContext.marketName} Not requoting. No need to move orders`,
        );
    }

    return instructions;
}

async function onExit(
    ctx: BotContext,
    marketContexts: MarketContext[],
) {
    const {
        client,
        group,
        payer,
        account
    } = ctx;

    await sleep(control.interval);

    ctx.account = await client.getMangoAccount(
        account.publicKey,
        group.dexProgramId,
    );
    let tx = new Transaction();
    const txProms: any[] = [];
    for (let i = 0; i < marketContexts.length; i++) {
        const mc = marketContexts[i];
        const cancelAllInstr = makeCancelAllPerpOrdersInstruction(
            ctx.groupConfig.mangoProgramId,
            group.publicKey,
            account.publicKey,
            payer.publicKey,
            mc.market.publicKey,
            mc.market.bids,
            mc.market.asks,
            new BN(20),
        );
        tx.add(cancelAllInstr);
        if (tx.instructions === MM_PARAMS.batch) {
            txProms.push(client.sendTransaction(tx, payer, []));
            tx = new Transaction();
        }
    }

    if (tx.instructions.length) {
        txProms.push(client.sendTransaction(tx, payer, []));
    }
    const txids = await Promise.all(txProms);
    txids.forEach((txid) => {
        console.log(`cancel successful: ${txid.toString()}`);
    });
    process.exit();
}

process.on('unhandledRejection', function (err, promise) {
    console.error(
        'Unhandled rejection (promise: ',
        promise,
        ', reason: ',
        err,
        ').',
    );
});