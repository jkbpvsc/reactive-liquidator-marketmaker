import {
    Cluster,
    Config,
    IDS,
    MangoAccount,
    MangoClient,
    MangoGroup,
    PerpTriggerOrder
} from "@blockworks-foundation/mango-client";
import {Account, Commitment, Connection, PublicKey} from "@solana/web3.js";
import fs from "fs";
import os from "os";

interface BotContext {
    connection: Connection,
    client: MangoClient,
    group: MangoGroup,
    account: MangoAccount,
}

function run() {
    // Load Cache, Liq Acc, Mango Accounts
    // Setup Shared State
    // Setup Task Queue
    // Setup Web Socket Connection
}

async function createContext(): Promise<BotContext> {
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

    return {
        connection,
        client,
        group,
        account,
    }
}