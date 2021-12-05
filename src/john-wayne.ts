import {Cluster, Config, IDS, MangoAccount, MangoClient, PerpTriggerOrder} from "@blockworks-foundation/mango-client";
import {Account, Commitment, Connection} from "@solana/web3.js";
import fs from "fs";
import os from "os";

type PerpTriggerElement = { mangoAccount: MangoAccount, order: PerpTriggerOrder, index: number } | null;

const config = new Config(IDS);

const cluster = (process.env.CLUSTER || 'mainnet') as Cluster;
const groupName = process.env.GROUP || 'mainnet.1';
const groupIds = config.getGroup(cluster, groupName);
if (!groupIds) {
    throw new Error(`Group ${groupName} not found`);
}

const TARGETS = process.env.TARGETS
    ? process.env.TARGETS.split(' ').map((s) => parseFloat(s))
    : [0, 0, 0, 0, 0, 0, 0, 0, 0];

const mangoProgramId = groupIds.mangoProgramId;
const mangoGroupKey = groupIds.publicKey;

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

const connection = new Connection(
    process.env.ENDPOINT_URL || config.cluster_urls[cluster],
    'processed' as Commitment,
);

const client = new MangoClient(connection, mangoProgramId);

let mangoSubscriptionId = -1;
let dexSubscriptionId = -1;

function run() {
    // Load Cache, Liq Acc, Mango Accounts
    // Setup Shared State
    // Setup Task Queue
    // Setup Web Socket Connection
}