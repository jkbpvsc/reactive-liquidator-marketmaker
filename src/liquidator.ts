import {BotContext, PerpTriggerElement} from "./bot";
import {
    AdvancedOrdersLayout,
    AssetType,
    getMultipleAccounts,
    I80F48,
    makeCachePricesInstruction,
    makeExecutePerpTriggerOrderInstruction, makeLiquidatePerpMarketInstruction,
    makeLiquidateTokenAndPerpInstruction,
    makeLiquidateTokenAndTokenInstruction,
    MangoAccount,
    MangoAccountLayout,
    MangoCacheLayout,
    ONE_I80F48,
    QUOTE_INDEX,
    sleep,
    ZERO_BN,
    ZERO_I80F48,
    zeroKey
} from "@blockworks-foundation/mango-client";
import {AccountInfo, KeyedAccountInfo, Transaction} from "@solana/web3.js";
import {OpenOrders} from "@project-serum/serum";
import debugCreator from 'debug';
import BN from "bn.js";
import {Orderbook} from "@project-serum/serum/lib/market";

import {
    BOT_MODE,
    BotModes,
    CHECK_TRIGGERS,
    COMMITMENT,
    HEALTH_THRESHOLD,
    INTERVAL,
    LOG_TIME,
    MAX_ACTIVE_TX,
    MIN_EQUITY,
    MIN_LIQOR_HEALTH,
    REFRESH_ACCOUNT_INTERVAL,
    REFRESH_WEBSOCKET_INTERVAL,
    SHOULD_BALANCE,
    TARGETS,
    TX_CACHE_RESET_DELAY
} from './config'

const websocket = {
    mangoSubscriptionId: -1,
    dexSubscriptionId: -1,
    cacheChangeSubscriptionId: -1,
}

export async function startLiquidator(context: BotContext) {
    const debug = debugCreator('liquidator');
    debug('Starting Liquidator')
    try {
        await refreshMangoAccounts(context);
        await watchAccounts(context);
    } catch (e) {
        console.error('Error running liquidator', e);
    }
}

async function refreshMangoAccounts(context: BotContext) {
    logTime('refreshAccounts')
    const debug = debugCreator('liquidator:refreshAccounts');
    debug('Refreshing Mango accounts');
    const mangoAccounts = await context.client.getAllMangoAccounts(context.group, undefined, true);
    filterAccounts(context, mangoAccounts);

    if (CHECK_TRIGGERS) {
        debug('Loading Perp Triggers');
        await loadPerpTriggers(context, mangoAccounts);
    }

    debug('Done');
    logTime('refreshAccounts', true)
    setTimeout(refreshMangoAccounts, REFRESH_ACCOUNT_INTERVAL, context);
}

function filterAccounts(context: BotContext, mangoAccounts: MangoAccount[]) {
    const healthThreshold = process.env.HEALTH_THRESHOLD ? Number.parseInt(process.env.HEALTH_THRESHOLD) : 10;
    const accountsToObserve = mangoAccounts
        .map(a => ({account: a, health: a.getHealthRatio(context.group, context.cache, 'Maint').toNumber()}))
        .sort((a, b) => a.health - b.health)
        .filter(({ health }) => health < healthThreshold)
        .map(a => a.account);

    context.liquidator?.mangoAccounts.splice(0,context.liquidator?.mangoAccounts.length, ...accountsToObserve);
}

async function loadPerpTriggers(context: BotContext, mangoAccounts: MangoAccount[]) {
    const mangoAccountsWithAOs = mangoAccounts.filter(
        (ma) => ma.advancedOrdersKey && !ma.advancedOrdersKey.equals(zeroKey),
    );
    const allAOs = mangoAccountsWithAOs.map((ma) => ma.advancedOrdersKey);
    const advancedOrders = await getMultipleAccounts(context.connection, allAOs);

    let triggers: PerpTriggerElement[] = []

    mangoAccountsWithAOs.forEach((ma, i) => {
        const decoded = AdvancedOrdersLayout.decode(advancedOrders[i].accountInfo.data,);
        ma.advancedOrders = decoded.orders;
    });

    for (let mangoAccount of mangoAccountsWithAOs) {
        for (let i = 0; i < mangoAccount.advancedOrders.length; i++) {
            const order = mangoAccount.advancedOrders[i];

            if (!(order.perpTrigger && order.perpTrigger.isActive)) {
                continue;
            }

            triggers.push({ mangoAccount, order: order.perpTrigger, index: i })
        }
    }

    context.liquidator?.perpTriggers.splice(0, context.liquidator?.perpTriggers.length, ...triggers);
}

async function watchAccounts(context: BotContext) {
    const debug = debugCreator('liquidator:watchAccounts');
    try {
        debug('Setting WS subscriptions');
        await resetWebsocketSubscriptions(context);
        setWebsocketSubscriptions(context);
    } catch (e) {
        console.error('Error watching accounts', e);
    } finally {
        setTimeout(watchAccounts, REFRESH_WEBSOCKET_INTERVAL, context);
    }
}

async function resetWebsocketSubscriptions(context: BotContext) {
    const connection = context.connection;
    if (websocket.mangoSubscriptionId != -1) {
        await connection.removeProgramAccountChangeListener(websocket.mangoSubscriptionId);
    }
    if (websocket.dexSubscriptionId != -1) {
        await connection.removeProgramAccountChangeListener(websocket.dexSubscriptionId);
    }
    if (websocket.cacheChangeSubscriptionId != -1) {
        await connection.removeAccountChangeListener(websocket.cacheChangeSubscriptionId);
    }
}

function setWebsocketSubscriptions(context: BotContext) {
    websocket.cacheChangeSubscriptionId = context.connection.onAccountChange(
        context.cache.publicKey,
        (accountInfo) => processCacheUpdate(accountInfo, context),
        COMMITMENT,
    )

    websocket.mangoSubscriptionId = context.connection.onProgramAccountChange(
        context.groupConfig.mangoProgramId,
        kai => processMangoUpdate(kai, context),
        COMMITMENT,
        [
            { dataSize: MangoAccountLayout.span },
            {
                memcmp: {
                    offset: MangoAccountLayout.offsetOf('mangoGroup'),
                    bytes: context.group.publicKey.toBase58(),
                }
            }
        ]
    )

    websocket.dexSubscriptionId = context.connection.onProgramAccountChange(
        context.group.dexProgramId,
        kai => processDexUpdate(kai, context),
        COMMITMENT,
        [
            { dataSize: OpenOrders.getLayout(context.group.dexProgramId).span },
            {
                memcmp: {
                    offset: OpenOrders.getLayout(context.group.dexProgramId).offsetOf('owner'),
                    bytes: context.group.signerKey.toBase58(),
                }
            }
        ]
    )
}

async function processCacheUpdate(accountInfo: AccountInfo<Buffer>, context: BotContext) {
    const latencyTag = 'cacheUpdate-' + Date.now();
    logTime(latencyTag)
    const pk = context.cache.publicKey;
    context.cache = MangoCacheLayout.decode(accountInfo.data);
    context.cache.publicKey = pk;

    await Promise.all([
        await checkTriggerOrders(context),
        await checkMangoAccounts(context),
    ]);

    await balanceAccount(context);
    logTime(latencyTag, true)
}

async function processMangoUpdate({ accountId, accountInfo }: KeyedAccountInfo, context: BotContext) {
    const latencyTag = 'mangoUpdate-' + Date.now();
    logTime(latencyTag);
    const mangoAccount = new MangoAccount(accountId, MangoAccountLayout.decode(accountInfo.data));
    triageMangoAccount(mangoAccount, context);

    if (CHECK_TRIGGERS) {
        await triageTriggers(mangoAccount, context);
    }
    logTime(latencyTag, true);
}

function triageMangoAccount(mangoAccount: MangoAccount, ctx: BotContext) {
    const debug = debugCreator('liquidator:sub:mango')
    const index = ctx.liquidator!.mangoAccounts.findIndex((account) =>
        account.publicKey.equals(mangoAccount.publicKey),
    );

    const accountHealth = mangoAccount.getHealthRatio(ctx.group, ctx.cache, 'Maint').toNumber();
    if (accountHealth < HEALTH_THRESHOLD) {
        if (index == -1) {
            ctx.liquidator!.mangoAccounts.push(mangoAccount);

            debug('New Account ' + mangoAccount.publicKey.toBase58());
        } else {
            mangoAccount.spotOpenOrdersAccounts = ctx.liquidator!.mangoAccounts[index].spotOpenOrdersAccounts;
            ctx.liquidator!.mangoAccounts[index] = mangoAccount;

            debug('Updated MangoAccount ' + mangoAccount.publicKey.toBase58());
        }
    }
}

async function triageTriggers(mangoAccount: MangoAccount, ctx: BotContext) {
    if (mangoAccount.advancedOrdersKey.equals(zeroKey)) {
        return;
    }

    const debug = debugCreator('liquidator:sub:mango:advancedOrders')
    debug('Loading AdvancedOrders for', mangoAccount.publicKey.toString())

    const advancedOrders = await mangoAccount.loadAdvancedOrders(ctx.connection);
    advancedOrders
        .filter(({ perpTrigger }) => perpTrigger?.isActive)
        .forEach(({ perpTrigger}, i) => {
            const index = ctx.liquidator!.perpTriggers.findIndex(trigger => trigger?.index === i && trigger.mangoAccount.publicKey.equals(mangoAccount.publicKey))

            if (index === -1) {
                debug('New AdvancedOrder', mangoAccount.publicKey.toString(), 'index', i, 'for MangoAccount', mangoAccount.publicKey.toString());
                ctx.liquidator!.perpTriggers.push({ mangoAccount, index: i, order: mangoAccount.advancedOrders[i].perpTrigger!})
            } else {
                debug('Updated AdvancedOrder', mangoAccount.publicKey.toString(), 'index', i, 'for MangoAccount', mangoAccount.publicKey.toString());
                ctx.liquidator!.perpTriggers[index] = { mangoAccount, index: i, order: mangoAccount.advancedOrders[i].perpTrigger!}
            }
        })

    mangoAccount.advancedOrders = advancedOrders;
}

async function processDexUpdate({ accountId, accountInfo }: KeyedAccountInfo, ctx: BotContext) {
    const latencyTag = 'dexUpdate-' + Date.now();
    logTime(latencyTag)

    const debug = debugCreator('liquidator:sub:dex')
    const ownerIndex = ctx.liquidator.mangoAccounts.findIndex((account) =>
        account.spotOpenOrders.some((key) => key.equals(accountId)),
    );

    if (ownerIndex > -1) {
        const openOrdersIndex = ctx.liquidator.mangoAccounts[ownerIndex].spotOpenOrders.findIndex((key) => key.equals(accountId));
        ctx.liquidator.mangoAccounts[ownerIndex].spotOpenOrdersAccounts[openOrdersIndex] =
            OpenOrders.fromAccountInfo(
                accountId,
                accountInfo,
                ctx.group.dexProgramId,
            );
        debug('Updated OpenOrders for account ' + ctx.liquidator.mangoAccounts[ownerIndex].publicKey.toBase58());
    } else {
        debug('Could not match OpenOrdersAccount to MangoAccount');
    }
    logTime(latencyTag, true);
}

async function checkTriggerOrders(ctx: BotContext) {
    if (!CHECK_TRIGGERS) {
        return
    }

    const debug = debugCreator('liquidator:exe:advancedOrders')

    const validTriggers = ctx.liquidator.perpTriggers.filter(e => e !== null);

    debug(`Advanced order queue ${validTriggers.length}`)

    await Promise.all(validTriggers
        .map(async (queueElement, index) => {

        const { order, mangoAccount } = queueElement!;

        const currentPrice = ctx.cache.priceCache[order.marketIndex].price;
        const configMarketIndex = ctx.groupConfig.perpMarkets.findIndex((pm) => pm.marketIndex === order.marketIndex);
        const perpMarket = ctx.perpMarkets[configMarketIndex];

            if (
            (order.triggerCondition == 'above' &&
                currentPrice.gt(order.triggerPrice)) ||
            (order.triggerCondition == 'below' &&
                currentPrice.lt(order.triggerPrice))
        ) {
            const txKey = `trigger-${mangoAccount.publicKey.toString()}-${queueElement!.index}`;

            debug(`Processing trigger ${txKey}, index: ${index}`)
            debug(`Order ${order.clientOrderId}`)

            ctx.liquidator.perpTriggers[index] = null

            if (await canExecuteTx(txKey, ctx)) {
                try {
                    const transaction = new Transaction();

                    transaction.add(makeCachePricesInstruction(
                        ctx.groupConfig.mangoProgramId,
                        ctx.group.publicKey,
                        ctx.cache.publicKey,
                        ctx.group.oracles
                    ));

                    transaction.add(makeExecutePerpTriggerOrderInstruction(
                        ctx.groupConfig.mangoProgramId,
                        ctx.group.publicKey,
                        mangoAccount.publicKey,
                        mangoAccount.advancedOrdersKey,
                        ctx.payer.publicKey,
                        ctx.group.mangoCache,
                        perpMarket.publicKey,
                        perpMarket.bids,
                        perpMarket.asks,
                        perpMarket.eventQueue,
                        mangoAccount.spotOpenOrders,
                        new BN(queueElement!.index),
                    ));

                    await ctx.client.sendTransaction(transaction, ctx.payer, [])

                    debug(`Processing ${txKey} successful`)

                    clearAtx(txKey, ctx, true);
                } catch (e) {
                    debug(`Processing ${txKey} failed`)
                    debug(e)
                    console.error(e)

                    clearAtx(txKey, ctx);
                }
            }
        }
    }))
}

function liquidatorAccountHealthy(ctx: BotContext): boolean {
    let liqorHealth = ctx.account.getHealthRatio(ctx.group, ctx.cache, 'Maint')

    return liqorHealth.toNumber() > MIN_LIQOR_HEALTH
}

function passesEquityThreshold(account: MangoAccount, ctx: BotContext) {
    const equity = account.computeValue(ctx.group, ctx.cache).toNumber()

    const hasMinEquity = equity >= MIN_EQUITY;

    if (!hasMinEquity) {
        console.log(`Account ${account.publicKey.toString()} doesn't have enough equity ${equity}, PASS`)
    }

    return hasMinEquity
}

async function checkMangoAccounts(ctx: BotContext) {
    const debug = debugCreator('liquidator:accountInspector');

    await Promise.all(ctx.liquidator.mangoAccounts.map(async (account, i) => {
        if (account.isLiquidatable(ctx.group, ctx.cache)) {
            await account.reload(ctx.connection, ctx.group.dexProgramId);

            if (!account.isLiquidatable(ctx.group, ctx.cache)) {
                debug(`Account ${account.publicKey.toBase58()} no longer liquidatable`);
                return
            }

            const txKey = `liquidate-${account.publicKey.toString()}}`;
            if (await canExecuteTx(txKey, ctx)) {
                try {
                    await liquidateAccount(account, ctx);
                } catch (e) {
                    debug(`Processing ${txKey} failed`)
                    console.error(e)
                } finally {
                    clearAtx(txKey, ctx);
                }
            }
        }
    }))
}

async function liquidateAccount(
    account: MangoAccount,
    ctx: BotContext,
) {

    if (!liquidatorAccountHealthy(ctx)) {
        console.error(`Liquidator unhealthy`);
        return;
    }

    if (!passesEquityThreshold(account, ctx)) {
      return;
    }

    const debug = debugCreator('liquidator:exe:liquidator')
    debug('Liquidating account', account.publicKey.toString());

    const hasPerpOpenOrders = account.perpAccounts.some((pa) => pa.bidsQuantity.gt(ZERO_BN) || pa.asksQuantity.gt(ZERO_BN));

    if (hasPerpOpenOrders) {
        debug('Closing perp orders');
        await Promise.all(
            ctx.perpMarkets.map((perpMarket) => {
                return ctx.client.forceCancelAllPerpOrdersInMarket(
                    ctx.group,
                    account,
                    perpMarket,
                    ctx.payer,
                    10,
                );
            }),
        );
        await sleep(INTERVAL * 2);
    }

    debug('Reloading account');

    await account.reload(ctx.connection, ctx.group.dexProgramId);
    if (!account.isLiquidatable(ctx.group, ctx.cache)) {
        debug('Account', account.publicKey.toString(), 'no longer liquidatable');
        throw new Error(`Account ${account.publicKey.toString()} no longer liquidatable`);
    }

    while (account.hasAnySpotOrders()) {
        debug('Closing spot orders for', account.publicKey.toString());
        for (let i = 0; i < ctx.group.spotMarkets.length; i++) {
            const spotMarket = ctx.spotMarkets[i];
            const baseRootBank = ctx.rootBanks[i];
            const quoteRootBank = ctx.rootBanks[QUOTE_INDEX];

            if (baseRootBank && quoteRootBank) {
                if (account.inMarginBasket[i]) {
                    debug('forceCancelOrders ', i);

                    await ctx.client.forceCancelSpotOrders(
                        ctx.group,
                        account,
                        spotMarket,
                        baseRootBank,
                        quoteRootBank,
                        ctx.payer,
                        new BN(5),
                    );
                }
            }
        }

        debug('Reloading account', account.publicKey.toString());
        await account.reload(ctx.connection, ctx.group.dexProgramId);
        if (!account.isLiquidatable(ctx.group, ctx.cache)) {
            debug('Account', account.publicKey.toString(), 'no longer liquidatable');
            throw new Error('Account no longer liquidatable');
        }
    }

    const healthComponents = account.getHealthComponents(ctx.group, ctx.cache);
    const maintHealths = account.getHealthsFromComponents(
        ctx.group,
        ctx.cache,
        healthComponents.spot,
        healthComponents.perps,
        healthComponents.quote,
        'Maint',
    );
    const initHealths = account.getHealthsFromComponents(
        ctx.group,
        ctx.cache,
        healthComponents.spot,
        healthComponents.perps,
        healthComponents.quote,
        'Init',
    );

    let shouldLiquidateSpot = false;
    for (let i = 0; i < ctx.group.tokens.length; i++) {
        shouldLiquidateSpot = account.getNet(ctx.cache.rootBankCache[i], i).isNeg();
    }

    const shouldLiquidatePerps =
        maintHealths.perp.lt(ZERO_I80F48) ||
        (initHealths.perp.lt(ZERO_I80F48) && account.beingLiquidated);

    if (shouldLiquidateSpot) {
        debug('Liquidating spot for', account.publicKey.toString());
        await liquidateSpot(account, ctx);
    }

    if (shouldLiquidatePerps) {
        debug('Liquidating perps for', account.publicKey.toString());
        await liquidatePerps(account, ctx);
    }

    if (
        !shouldLiquidateSpot &&
        !maintHealths.perp.isNeg() &&
        account.beingLiquidated
    ) {
        // Send a ForceCancelPerp to reset the being_liquidated flag
        await ctx.client.forceCancelAllPerpOrdersInMarket(
            ctx.group,
            account,
            ctx.perpMarkets[0],
            ctx.payer,
            10,
        );
    }
}

async function liquidateSpot(
    liqee: MangoAccount,
    ctx: BotContext,
) {
    const {
        cache,
        group,
        rootBanks,
        account,
        client,
        connection,
        payer,
        perpMarkets
    } = ctx;

    const debug = debugCreator('liquidator:exe:liquidator:spot')
    debug('liquidateSpot');

    let minNet = ZERO_I80F48;
    let minNetIndex = -1;
    let maxNet = ZERO_I80F48;
    let maxNetIndex = -1;

    for (let i = 0; i < group.tokens.length; i++) {
        const price = cache.priceCache[i] ? cache.priceCache[i].price : ONE_I80F48;
        const netDeposit = liqee
            .getNativeDeposit(cache.rootBankCache[i], i)
            .sub(liqee.getNativeBorrow(cache.rootBankCache[i], i))
            .mul(price);

        if (netDeposit.lt(minNet)) {
            minNet = netDeposit;
            minNetIndex = i;
        } else if (netDeposit.gt(maxNet)) {
            maxNet = netDeposit;
            maxNetIndex = i;
        }
    }
    if (minNetIndex == -1) {
        throw new Error('min net index neg 1');
    }

    if (minNetIndex == maxNetIndex) {
        maxNetIndex = QUOTE_INDEX;
    }

    const liabRootBank = rootBanks[minNetIndex];
    const assetRootBank = rootBanks[maxNetIndex];

    if (assetRootBank && liabRootBank) {
        const liqorInitHealth = account.getHealth(group, cache, 'Init');
        const liabInitLiabWeight = group.spotMarkets[minNetIndex]
            ? group.spotMarkets[minNetIndex].initLiabWeight
            : ONE_I80F48;
        const assetInitAssetWeight = group.spotMarkets[maxNetIndex]
            ? group.spotMarkets[maxNetIndex].initAssetWeight
            : ONE_I80F48;

        const maxLiabTransfer = liqorInitHealth.div(
            group
                .getPriceNative(minNetIndex, cache)
                .mul(liabInitLiabWeight.sub(assetInitAssetWeight).abs()),
        );

        if (liqee.isBankrupt) {
            debug('Bankrupt account', liqee.publicKey.toBase58());
            const quoteRootBank = rootBanks[QUOTE_INDEX];
            if (quoteRootBank) {
                await client.resolveTokenBankruptcy(
                    group,
                    liqee,
                    account,
                    quoteRootBank,
                    liabRootBank,
                    payer,
                    maxLiabTransfer,
                );
                await liqee.reload(connection, group.dexProgramId);
            }
        } else {
            debug(
                `Liquidating max ${maxLiabTransfer.toString()}/${liqee.getNativeBorrow(
                    liabRootBank,
                    minNetIndex,
                )} of liab ${minNetIndex}, asset ${maxNetIndex}`,
            );
            debug(maxNet.toString());
            if (maxNet.lt(ONE_I80F48) || maxNetIndex == -1) {
                const highestHealthMarket = perpMarkets
                    .map((perpMarket, i) => {
                        const marketIndex = group.getPerpMarketIndex(
                            perpMarket.publicKey,
                        );
                        const perpMarketInfo = group.perpMarkets[marketIndex];
                        const perpAccount = liqee.perpAccounts[marketIndex];
                        const perpMarketCache = cache.perpMarketCache[marketIndex];
                        const price = group.getPriceNative(marketIndex, cache);
                        const perpHealth = perpAccount.getHealth(
                            perpMarketInfo,
                            price,
                            perpMarketInfo.maintAssetWeight,
                            perpMarketInfo.maintLiabWeight,
                            perpMarketCache.longFunding,
                            perpMarketCache.shortFunding,
                        );
                        return {perpHealth: perpHealth, marketIndex: marketIndex, i};
                    })
                    .sort((a, b) => {
                        return b.perpHealth.sub(a.perpHealth).toNumber();
                    })[0];

                let maxLiabTransfer = liqorInitHealth;
                if (maxNetIndex !== QUOTE_INDEX) {
                    maxLiabTransfer = liqorInitHealth.div(
                        ONE_I80F48.sub(assetInitAssetWeight),
                    );
                }

                debug('liquidateTokenAndPerp ' + highestHealthMarket.marketIndex);
                // await client.liquidateTokenAndPerp(
                //     group,
                //     liqee,
                //     account,
                //     liabRootBank,
                //     payer,
                //     AssetType.Perp,
                //     highestHealthMarket.marketIndex,
                //     AssetType.Token,
                //     minNetIndex,
                //     liqee.perpAccounts[highestHealthMarket.marketIndex].quotePosition,
                // );

                const transaction = new Transaction();

                transaction.add(makeCachePricesInstruction(
                    ctx.groupConfig.mangoProgramId,
                    ctx.group.publicKey,
                    ctx.cache.publicKey,
                    ctx.group.oracles
                ));

                transaction.add(makeLiquidateTokenAndPerpInstruction(
                    ctx.groupConfig.mangoProgramId,
                    ctx.group.publicKey,
                    ctx.cache.publicKey,
                    liqee.publicKey,
                    account.publicKey,
                    payer.publicKey,
                    liabRootBank.publicKey,
                    liabRootBank.nodeBanks[0],
                    liqee.spotOpenOrders,
                    account.spotOpenOrders,
                    AssetType.Perp,
                    new BN(highestHealthMarket.marketIndex),
                    AssetType.Token,
                    new BN(minNetIndex),
                    liqee.perpAccounts[highestHealthMarket.marketIndex].quotePosition,
                ))

                await ctx.client.sendTransaction(transaction, ctx.payer, [])
            } else {
                const transaction = new Transaction();

                transaction.add(makeCachePricesInstruction(
                    ctx.groupConfig.mangoProgramId,
                    ctx.group.publicKey,
                    ctx.cache.publicKey,
                    ctx.group.oracles
                ));

                transaction.add(makeLiquidateTokenAndTokenInstruction(
                    ctx.groupConfig.mangoProgramId,
                    ctx.group.publicKey,
                    ctx.cache.publicKey,
                    liqee.publicKey,
                    account.publicKey,
                    payer.publicKey,
                    assetRootBank.publicKey,
                    assetRootBank.nodeBanks[0], // Randomize node bank pick
                    liabRootBank.publicKey,
                    liabRootBank.nodeBanks[0], // Randomize node bank pick
                    liqee.spotOpenOrders,
                    account.spotOpenOrders,
                    maxLiabTransfer,
                ))

                await ctx.client.sendTransaction(transaction, ctx.payer, [])

                // await client.liquidateTokenAndToken(
                //     group,
                //     liqee,
                //     account,
                //     assetRootBank,
                //     liabRootBank,
                //     payer,
                //     maxLiabTransfer,
                // );
            }

            await liqee.reload(connection, group.dexProgramId);
            if (liqee.isBankrupt) {
                debug('Bankrupt account', liqee.publicKey.toBase58());
                const quoteRootBank = rootBanks[QUOTE_INDEX];
                if (quoteRootBank) {
                    await client.resolveTokenBankruptcy(
                        group,
                        liqee,
                        account,
                        quoteRootBank,
                        liabRootBank,
                        payer,
                        maxLiabTransfer,
                    );
                    await liqee.reload(connection, group.dexProgramId);
                }
            }
        }
    }
}

async function liquidatePerps(
    liqee: MangoAccount,
    ctx: BotContext,
) {
    const {
        perpMarkets,
        group,
        cache,
        connection,
        payer,
        account,
        rootBanks,
        client
    } = ctx;

    const debug = debugCreator('liquidator:exe:liquidator:perps')
    debug('liquidatePerps');
    const lowestHealthMarket = perpMarkets
        .map((perpMarket, i) => {
            const marketIndex = group.getPerpMarketIndex(perpMarket.publicKey);
            const perpMarketInfo = group.perpMarkets[marketIndex];
            const perpAccount = liqee.perpAccounts[marketIndex];
            const perpMarketCache = cache.perpMarketCache[marketIndex];
            const price = group.getPriceNative(marketIndex, cache);
            const perpHealth = perpAccount.getHealth(
                perpMarketInfo,
                price,
                perpMarketInfo.maintAssetWeight,
                perpMarketInfo.maintLiabWeight,
                perpMarketCache.longFunding,
                perpMarketCache.shortFunding,
            );
            return {perpHealth: perpHealth, marketIndex: marketIndex, i};
        })
        .sort((a, b) => {
            return a.perpHealth.sub(b.perpHealth).toNumber();
        })[0];

    if (!lowestHealthMarket) {
        throw new Error('Couldnt find a perp market to liquidate');
    }

    const marketIndex = lowestHealthMarket.marketIndex;
    const perpAccount = liqee.perpAccounts[marketIndex];
    const perpMarket = perpMarkets[lowestHealthMarket.i];
    // const baseRootBank = rootBanks[marketIndex];
    //
    // if (!baseRootBank) {
    //   throw new Error(`Base root bank not found for ${marketIndex}`);
    // }

    if (!perpMarket) {
        throw new Error(`Perp market not found for ${marketIndex}`);
    }

    if (liqee.isBankrupt) {
        const maxLiabTransfer = perpAccount.quotePosition.abs();
        const quoteRootBank = rootBanks[QUOTE_INDEX];
        if (quoteRootBank) {
            // don't do anything it if quote position is zero
            debug('resolvePerpBankruptcy', maxLiabTransfer.toString());
            await client.resolvePerpBankruptcy(
                group,
                liqee,
                account,
                perpMarket,
                quoteRootBank,
                payer,
                marketIndex,
                maxLiabTransfer,
            );
            await liqee.reload(connection, group.dexProgramId);
        }
    } else {
        let maxNet = ZERO_I80F48;
        let maxNetIndex = group.tokens.length - 1;

        for (let i = 0; i < group.tokens.length; i++) {
            const price = cache.priceCache[i]
                ? cache.priceCache[i].price
                : ONE_I80F48;

            const netDeposit = liqee.getNet(cache.rootBankCache[i], i).mul(price);
            if (netDeposit.gt(maxNet)) {
                maxNet = netDeposit;
                maxNetIndex = i;
            }
        }

        const assetRootBank = rootBanks[maxNetIndex];
        const liqorInitHealth = account.getHealth(group, cache, 'Init');
        if (perpAccount.basePosition.isZero()) {
            if (assetRootBank) {
                // we know that since sum of perp healths is negative, lowest perp market must be negative
                debug('liquidateTokenAndPerp ' + marketIndex);
                // maxLiabTransfer
                let maxLiabTransfer = liqorInitHealth;
                if (maxNetIndex !== QUOTE_INDEX) {
                    maxLiabTransfer = liqorInitHealth.div(
                        ONE_I80F48.sub(group.spotMarkets[maxNetIndex].initAssetWeight),
                    );
                }
                // await client.liquidateTokenAndPerp(
                //     group,
                //     liqee,
                //     account,
                //     assetRootBank,
                //     payer,
                //     AssetType.Token,
                //     maxNetIndex,
                //     AssetType.Perp,
                //     marketIndex,
                //     maxLiabTransfer,
                // );

                const transaction = new Transaction();

                transaction.add(makeCachePricesInstruction(
                    ctx.groupConfig.mangoProgramId,
                    ctx.group.publicKey,
                    ctx.cache.publicKey,
                    ctx.group.oracles
                ));

                transaction.add(makeLiquidateTokenAndPerpInstruction(
                    ctx.groupConfig.mangoProgramId,
                    ctx.group.publicKey,
                    ctx.cache.publicKey,
                    liqee.publicKey,
                    account.publicKey,
                    payer.publicKey,
                    assetRootBank.publicKey,
                    assetRootBank.nodeBanks[0],
                    liqee.spotOpenOrders,
                    account.spotOpenOrders,
                    AssetType.Token,
                    new BN(maxNetIndex),
                    AssetType.Perp,
                    new BN(marketIndex),
                    maxLiabTransfer,
                ))

                await ctx.client.sendTransaction(transaction, ctx.payer, [])
            }
        } else {
            debug('liquidatePerpMarket ' + marketIndex);

            // technically can be higher because of liquidation fee, but
            // let's just give ourselves extra room
            const perpMarketInfo = group.perpMarkets[marketIndex];
            const initAssetWeight = perpMarketInfo.initAssetWeight;
            const initLiabWeight = perpMarketInfo.initLiabWeight;
            let baseTransferRequest: BN;
            if (perpAccount.basePosition.gte(ZERO_BN)) {
                // TODO adjust for existing base position on liqor
                baseTransferRequest = new BN(
                    liqorInitHealth
                        .div(ONE_I80F48.sub(initAssetWeight))
                        .div(group.getPriceNative(marketIndex, cache))
                        .div(I80F48.fromI64(perpMarketInfo.baseLotSize))
                        .floor()
                        .toNumber(),
                );
            } else {
                baseTransferRequest = new BN(
                    liqorInitHealth
                        .div(initLiabWeight.sub(ONE_I80F48))
                        .div(group.getPriceNative(marketIndex, cache))
                        .div(I80F48.fromI64(perpMarketInfo.baseLotSize))
                        .floor()
                        .toNumber(),
                ).neg();
            }

            // await client.liquidatePerpMarket(
            //     group,
            //     liqee,
            //     account,
            //     perpMarket,
            //     payer,
            //     baseTransferRequest,
            // );

            const transaction = new Transaction();

            transaction.add(makeCachePricesInstruction(
                ctx.groupConfig.mangoProgramId,
                ctx.group.publicKey,
                ctx.cache.publicKey,
                ctx.group.oracles
            ));

            transaction.add(makeLiquidatePerpMarketInstruction(
                ctx.groupConfig.mangoProgramId,
                ctx.group.publicKey,
                ctx.cache.publicKey,
                perpMarket.publicKey,
                perpMarket.eventQueue,
                liqee.publicKey,
                account.publicKey,
                payer.publicKey,
                liqee.spotOpenOrders,
                account.spotOpenOrders,
                baseTransferRequest,
            ))

            await ctx.client.sendTransaction(transaction, ctx.payer, [])
        }

        await sleep(INTERVAL);
        await liqee.reload(connection, group.dexProgramId);
        if (liqee.isBankrupt) {
            const maxLiabTransfer = perpAccount.quotePosition.abs();
            const quoteRootBank = rootBanks[QUOTE_INDEX];
            if (quoteRootBank) {
                debug('resolvePerpBankruptcy', maxLiabTransfer.toString());
                await client.resolvePerpBankruptcy(
                    group,
                    liqee,
                    account,
                    perpMarket,
                    quoteRootBank,
                    payer,
                    marketIndex,
                    maxLiabTransfer,
                );
            }
            await liqee.reload(connection, group.dexProgramId);
        }
    }
}

async function balanceAccount(ctx: BotContext) {
    if (!SHOULD_BALANCE) {
        return
    }
    const debug = debugCreator('liquidator:balanceAccount')
    debug('Acquiring lock')
    ctx.control.lock.acquire('balanceAccount', async () => {
        debug('Lock acquired')
        const {
            spotMarkets,
            perpMarkets,
            group,
            account
        } = ctx;

        const {diffs, netValues} = getDiffsAndNet(ctx);
        const tokensUnbalanced = netValues.some(
            (nv) => Math.abs(diffs[nv[0]].toNumber()) > spotMarkets[nv[0]].minOrderSize,
        );
        const positionsUnbalanced = perpMarkets.some((pm) => {
            const index = group.getPerpMarketIndex(pm.publicKey);
            const perpAccount = account.perpAccounts[index];
            const basePositionSize = Math.abs(
                pm.baseLotsToNumber(perpAccount.basePosition),
            );

            return basePositionSize != 0 || perpAccount.quotePosition.gt(ZERO_I80F48);
        });

        debug(`Tokens unbalanced: ${tokensUnbalanced}, positions unbalanced ${positionsUnbalanced}`);

        if (tokensUnbalanced) {
            await balanceTokens(ctx);
        }

        if (positionsUnbalanced) {
            await closePositions(ctx);
        }

        debug('Lock released')
    });
}

async function balanceTokens(
    ctx: BotContext
) {
    const debug = debugCreator('liquidator:balanceTokens');
    const {
        connection,
        group,
        spotMarkets,
        account,
        client,
        payer,
        groupConfig
    } = ctx;
    try {
        debug('balanceTokens');
        await account.reload(connection, group.dexProgramId);
        const cache = await group.loadCache(connection);
        const cancelOrdersPromises: Promise<string>[] = [];
        const bidsInfo = await getMultipleAccounts(
            connection,
            spotMarkets.map((m) => m.bidsAddress),
        );
        const bids = bidsInfo
            ? bidsInfo.map((o, i) => Orderbook.decode(spotMarkets[i], o.accountInfo.data))
            : [];
        const asksInfo = await getMultipleAccounts(
            connection,
            spotMarkets.map((m) => m.asksAddress),
        );
        const asks = asksInfo
            ? asksInfo.map((o, i) => Orderbook.decode(spotMarkets[i], o.accountInfo.data))
            : [];

        for (let i = 0; i < spotMarkets.length; i++) {
            const marketIndex = group.getSpotMarketIndex(spotMarkets[i].publicKey);
            const orders = [...bids[i], ...asks[i]].filter((o) =>
                o.openOrdersAddress.equals(account.spotOpenOrders[marketIndex]),
            );

            for (const order of orders) {
                cancelOrdersPromises.push(
                    client.cancelSpotOrder(
                        group,
                        account,
                        payer,
                        spotMarkets[i],
                        order,
                    ),
                );
            }
        }
        debug(`Cancelling ${cancelOrdersPromises.length} orders`);
        await Promise.all(cancelOrdersPromises);

        const openOrders = await account.loadOpenOrders(
            connection,
            group.dexProgramId,
        );
        const settlePromises: Promise<string>[] = [];
        for (let i = 0; i < spotMarkets.length; i++) {
            const marketIndex = group.getSpotMarketIndex(spotMarkets[i].publicKey);
            const oo = openOrders[marketIndex];
            if (
                oo &&
                (oo.quoteTokenTotal.add(oo['referrerRebatesAccrued']).gt(new BN(0)) ||
                    oo.baseTokenTotal.gt(new BN(0)))
            ) {
                settlePromises.push(
                    client.settleFunds(group, account, payer, spotMarkets[i]),
                );
            }
        }
        debug(`Settling on ${settlePromises.length} markets`);
        await Promise.all(settlePromises);

        const { diffs, netValues } = getDiffsAndNet(ctx);

        netValues.sort((a, b) => b[1].sub(a[1]).toNumber());
        for (let i = 0; i < groupConfig!.spotMarkets.length; i++) {
            const marketIndex = netValues[i][2];
            const netIndex = netValues[i][0];
            const marketConfig = groupConfig!.spotMarkets.find((m) => m.marketIndex == marketIndex)!
            const market = spotMarkets.find((m) => m.publicKey.equals(group.spotMarkets[marketIndex].spotMarket))!;
            const liquidationFee = group.spotMarkets[marketIndex].liquidationFee;
            if (Math.abs(diffs[netIndex].toNumber()) > market!.minOrderSize) {
                const side = netValues[i][1].gt(ZERO_I80F48) ? 'sell' : 'buy';
                const price = group
                    .getPrice(marketIndex, cache)
                    .mul(
                        side == 'buy'
                            ? ONE_I80F48.add(liquidationFee)
                            : ONE_I80F48.sub(liquidationFee),
                    )
                    .toNumber();
                const quantity = Math.abs(diffs[netIndex].toNumber());

                debug(
                    `${side}ing ${quantity} of ${marketConfig.baseSymbol} for $${price}`,
                );
                await client.placeSpotOrder(
                    group,
                    account,
                    group.mangoCache,
                    market,
                    payer,
                    side,
                    price,
                    Math.abs(diffs[netIndex].toNumber()),
                    'limit',
                );
                await client.settleFunds(
                    group,
                    account,
                    payer,
                    spotMarkets[marketIndex],
                );
            }
        }
    } catch (err) {
        console.error('Error rebalancing tokens', err);
    }
}

function getDiffsAndNet({ groupConfig, account, cache, group }: BotContext) {
    const diffs: I80F48[] = [];
    const netValues: [number, I80F48, number][] = [];
    // Go to each base currency and see if it's above or below target

    for (let i = 0; i < groupConfig!.spotMarkets.length; i++) {
        const target = TARGETS[i] !== undefined ? TARGETS[i] : 0;
        const marketIndex = groupConfig!.spotMarkets[i].marketIndex;
        const diff = account
            .getUiDeposit(cache.rootBankCache[marketIndex], group, marketIndex)
            .sub(account.getUiBorrow(cache.rootBankCache[marketIndex], group, marketIndex))
            .sub(I80F48.fromNumber(target));
        diffs.push(diff);
        netValues.push([i, diff.mul(cache.priceCache[i].price), marketIndex]);
    }

    return { diffs, netValues };
}

async function closePositions(
    { connection, client, payer, account, group, perpMarkets }: BotContext
) {
    const debug = debugCreator('liquidator:closePositions');

    if (BOT_MODE === BotModes.LiquidatorAndMarketMaker) {
        debug('Perp positions are managed by the market maker, skipping re-balance');
        return;
    }

    try {
        debug('closePositions');
        await account.reload(connection, group.dexProgramId);
        const cache = await group.loadCache(connection);

        for (let i = 0; i < perpMarkets.length; i++) {
            const perpMarket = perpMarkets[i];
            const index = group.getPerpMarketIndex(perpMarket.publicKey);
            const perpAccount = account.perpAccounts[index];

            if (perpMarket && perpAccount) {
                const openOrders = await perpMarket.loadOrdersForAccount(
                    connection,
                    account,
                );

                for (const oo of openOrders) {
                    await client.cancelPerpOrder(
                        group,
                        account,
                        payer,
                        perpMarket,
                        oo,
                    );
                }

                const basePositionSize = Math.abs(
                    perpMarket.baseLotsToNumber(perpAccount.basePosition),
                );
                const price = group.getPrice(index, cache);

                if (basePositionSize != 0) {
                    const side = perpAccount.basePosition.gt(ZERO_BN) ? 'sell' : 'buy';
                    // const liquidationFee =
                    //   mangoGroup.perpMarkets[index].liquidationFee.toNumber();

                    const orderPrice =
                        side == 'sell' ? price.toNumber() * 0.95 : price.toNumber() * 1.05; // TODO: base this on liquidation fee

                    debug(
                        side +
                        'ing ' +
                        basePositionSize +
                        ' of perp ' +
                        i +
                        ' for $' +
                        orderPrice,
                    );
                    await client.placePerpOrder(
                        group,
                        account,
                        cache.publicKey,
                        perpMarket,
                        payer,
                        side,
                        orderPrice,
                        basePositionSize,
                        'ioc',
                        undefined,
                        undefined,
                        true,
                    );
                }

                await account.reload(connection, group.dexProgramId);

                if (perpAccount.quotePosition.gt(ZERO_I80F48)) {
                    const quoteRootBank = group.rootBankAccounts[QUOTE_INDEX];
                    if (quoteRootBank) {
                        debug('settlePnl');
                        await client.settlePnl(
                            group,
                            cache,
                            account,
                            perpMarket,
                            quoteRootBank,
                            cache.priceCache[index].price,
                            payer,
                        );
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error closing positions', err);
    }
}

const LOCK_KEY = 'atx_lock';

function canExecuteTx(key: string, ctx: BotContext): Promise<boolean> {
    return new Promise<boolean>(((resolve, reject) => {
        ctx.control.lock.acquire(LOCK_KEY, () => {
            const debug = debugCreator('liquidator:exe:tx:controller')

            debug(`Diagnostic: eval tx key ${key}`)

            const activeTxsCount = Object.keys(ctx.control.activeTxReg).length;
            debug(`Active txs ${activeTxsCount}`)

            if (ctx.control.activeTxReg[key]) {
                debug(`Tx active ${key}, skipping`)
                resolve(false);
                return
            }

            if (activeTxsCount >= MAX_ACTIVE_TX) {
                debug(`Too many active txs, skipping`)
                resolve(false);
                return
            }

            ctx.control.activeTxReg[key] = true;
            resolve(true);
        });
    }))
}

function clearAtx(key: string, ctx: BotContext, instant: boolean = false) {
    const debug = debugCreator('liquidator:exe:tx:controller')
    const delayTime = instant ? 0 : TX_CACHE_RESET_DELAY

    debug(`Priming remove ${key} from active tx reg in ${ delayTime /(1000 * 60)}m, ${Object.keys(ctx.control.activeTxReg).length} atx remaining`);
    setTimeout(() => {
        ctx.control.lock.acquire(LOCK_KEY, () => {
            delete ctx.control.activeTxReg[key]
            debug(`Removing ${key} from active tx reg, ${Object.keys(ctx.control.activeTxReg).length} atx remaining`);
        });
    }, delayTime);
}

function logTime(label: string, end: boolean = false) {
    if (!LOG_TIME) {
       return
    }

    if (!end) {
        console.time(label);
    } else {
        console.timeEnd(label)
    }
}