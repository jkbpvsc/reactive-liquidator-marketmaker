import {
    Cluster,
    Config,
    GroupConfig,
    IDS,
    MangoAccount,
    MangoCache,
    MangoClient,
    MangoGroup,
    PerpMarket,
    PerpTriggerOrder,
    RootBank
} from "@blockworks-foundation/mango-client";
import {Account, Commitment, Connection, PublicKey} from "@solana/web3.js";
import fs from "fs";
import os from "os";
import debugCreator from 'debug';
import {Market} from "@project-serum/serum";
import {startLiquidator} from "./liquidator";
import path from "path";
import {startMarketMaker} from "./market_maker";
import {BOT_MODE, BotModes} from "./config";

import AsyncLock from 'async-lock';

debugCreator.log = console.info.bind(console);

export type PerpTriggerElement = { mangoAccount: MangoAccount, order: PerpTriggerOrder, index: number };

export interface BotContext {
    connection: Connection,
    groupConfig: GroupConfig,
    client: MangoClient,
    group: MangoGroup,
    account: MangoAccount,
    cache: MangoCache,
    perpMarkets: PerpMarket[],
    spotMarkets: Market[],
    rootBanks: (RootBank | undefined)[],
    payer: Account,
    liquidator: {
        mangoAccounts: MangoAccount[],
        perpTriggers: (PerpTriggerElement | null)[]
    },
    marketMaker: {
        params: any,
    },
    control: {
        activeTxReg: {
            [txId: string]: boolean
        },
        checkReBalance: boolean,
        lock: AsyncLock
    }
}

run();

async function run() {
    const context = await createContext();

    if (BOT_MODE === BotModes.LiquidatorAndMarketMaker || BOT_MODE === BotModes.LiquidatorOnly) {
        startLiquidator(context);
    }

    if (BOT_MODE === BotModes.LiquidatorAndMarketMaker || BOT_MODE === BotModes.MarketMakerOnly) {
        startMarketMaker(context);
    }
}

async function createContext(): Promise<BotContext> {
    const debug = debugCreator('john-wayne');
    debug('Starting bot');
    const config = new Config(IDS);
    const cluster = (process.env.CLUSTER || 'mainnet') as Cluster;

    const connection = new Connection(
        process.env.ENDPOINT_URL || config.cluster_urls[cluster],
        'processed' as Commitment,
    );

    const groupName = process.env.GROUP || 'mainnet.1';
    const groupIds = config.getGroup(cluster, groupName);

    if (!groupIds) {
        throw new Error(`Group ${groupName} not found`);
    }

    const mangoProgramId = groupIds.mangoProgramId;
    const mangoGroupKey = groupIds.publicKey;

    const client = new MangoClient(connection, mangoProgramId);

    const mangoGroup = await client.getMangoGroup(mangoGroupKey);

    const payer = new Account(
        JSON.parse(
            process.env.PRIVATE_KEY ||
            fs.readFileSync(
                process.env.KEYPAIR || os.homedir() + '/.config/solana/id.json',
                'utf-8',
            ),
        ),
    );
    debug(`Payer: ${payer.publicKey.toBase58()}`);

    const cache = await mangoGroup.loadCache(connection);

    let liqorMangoAccount: MangoAccount;
    if (process.env.LIQOR_PK) {
        liqorMangoAccount = await client.getMangoAccount(
            new PublicKey(process.env.LIQOR_PK),
            mangoGroup.dexProgramId,
        );
        if (!liqorMangoAccount.owner.equals(payer.publicKey)) {
            throw new Error('Account not owned by Keypair');
        }
    } else {
        const accounts = await client.getMangoAccountsForOwner(
            mangoGroup,
            payer.publicKey,
            true,
        );
        if (accounts.length) {
            accounts.sort((a, b) =>
                b
                    .computeValue(mangoGroup, cache)
                    .sub(a.computeValue(mangoGroup, cache))
                    .toNumber(),
            );
            liqorMangoAccount = accounts[0];
        } else {
            throw new Error('No Mango Account found for this Keypair');
        }
    }

    const perpMarkets = await Promise.all(
        groupIds!.perpMarkets.map((perpMarket) => {
            return mangoGroup.loadPerpMarket(
                connection,
                perpMarket.marketIndex,
                perpMarket.baseDecimals,
                perpMarket.quoteDecimals,
            );
        }),
    );
    const spotMarkets = await Promise.all(
        groupIds!.spotMarkets.map((spotMarket) => {
            return Market.load(
                connection,
                spotMarket.publicKey,
                undefined,
                groupIds!.serumProgramId,
            );
        }),
    );
    const rootBanks = await mangoGroup.loadRootBanks(connection);

    const paramsFileName = process.env.PARAMS || 'default.json';
    const params = JSON.parse(
        fs.readFileSync(
            path.resolve(__dirname, `../params/${paramsFileName}`),
            'utf-8',
        ),
    );

    debug('Running mode', BOT_MODE);

    return {
        groupConfig: groupIds,
        connection,
        client,
        group: mangoGroup,
        account: liqorMangoAccount,
        cache,
        perpMarkets,
        spotMarkets,
        rootBanks,
        payer,
        liquidator: {
            mangoAccounts: [],
            perpTriggers: []
        },
        marketMaker: {
            params,
        },
        control: {
            checkReBalance: false,
            activeTxReg: {},
            lock: new AsyncLock(),
        }
    }
}