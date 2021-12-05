// test is broken :(
import fs from 'fs';
import os from 'os';
import {
  Cluster,
  Config,
  MangoClient,
  sleep,
  QUOTE_INDEX,
  IDS,
} from '@blockworks-foundation/mango-client';
import {
  Account,
  Commitment,
  Connection,
} from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { spawn } from 'child_process';

async function testPerpLiquidationAndBankruptcy() {
  const cluster = (process.env.CLUSTER || 'devnet') as Cluster;
  const config = new Config(IDS);

  const payer = new Account(
    JSON.parse(
      process.env.KEYPAIR ||
        fs.readFileSync(os.homedir() + '/.config/solana/devnet.json', 'utf-8'),
    ),
  );
  
  const connection = new Connection(
    config.cluster_urls[cluster],
    'processed' as Commitment,
  );

  const groupIds = config.getGroup(cluster, 'devnet.3');
  if (!groupIds) {
    throw new Error(`Group not found`);
  }

  const client = new MangoClient(connection, groupIds.mangoProgramId);
  const mangoGroup = await client.getMangoGroup(groupIds.publicKey);
  debug(mangoGroup.admin.toBase58());
  const perpMarkets = await Promise.all(
    groupIds.perpMarkets.map((perpMarket) => {
      return mangoGroup.loadPerpMarket(
        connection,
        perpMarket.marketIndex,
        perpMarket.baseDecimals,
        perpMarket.quoteDecimals,
      );
    }),
  );
  const spotMarkets = await Promise.all(
    groupIds.spotMarkets.map((spotMarket) => {
      return Market.load(
        connection,
        spotMarket.publicKey,
        undefined,
        groupIds.serumProgramId,
      );
    }),
  );

  // Run keeper
  const keeper = spawn('yarn', ['keeper'], {
    env: {
      CLUSTER: 'devnet',
      GROUP: 'devnet.3',
      PATH: process.env.PATH
    },
  });
  // keeper.stdout.on('data', (data) => {
  //   debug(`keeper stdout: ${data}`);
  // });
  keeper.stderr.on('data', (data) => {
    console.error(`keeper stderr: ${data}`);
  });

  keeper.on('close', (code) => {
    debug(`keeper exited with code ${code}`);
  });

  // Run crank
  const crank = spawn('yarn', ['crank'], {
    env: {
      CLUSTER: 'devnet',
      GROUP: 'devnet.3',
      PATH: process.env.PATH
    },
  });

  crank.stderr.on('data', (data) => {
    console.error(`crank stderr: ${data}`);
  });

  crank.on('close', (code) => {
    debug(`crank exited with code ${code}`);
  });

  let cache = await mangoGroup.loadCache(connection);
  const rootBanks = await mangoGroup.loadRootBanks(connection);
  const quoteRootBank = rootBanks[QUOTE_INDEX];
  if (!quoteRootBank) {
    throw new Error('Quote Rootbank Not Found');
  }
  const quoteNodeBanks = await quoteRootBank.loadNodeBanks(connection);
  const quoteTokenInfo = mangoGroup.tokens[QUOTE_INDEX];
  const quoteToken = new Token(
    connection,
    quoteTokenInfo.mint,
    TOKEN_PROGRAM_ID,
    payer,
  );
  const quoteWallet = await quoteToken.getOrCreateAssociatedAccountInfo(
    payer.publicKey,
  );

  const btcToken = new Token(
    connection,
    mangoGroup.tokens[1].mint,
    TOKEN_PROGRAM_ID,
    payer,
  );
  const btcWallet = await btcToken.getOrCreateAssociatedAccountInfo(
    payer.publicKey,
  );

  const liqorPk = await client.initMangoAccount(mangoGroup, payer);
  const liqorAccount = await client.getMangoAccount(
    liqorPk,
    mangoGroup.dexProgramId,
  );
  debug('Created Liqor:', liqorPk.toBase58());

  const liqeePk = await client.initMangoAccount(mangoGroup, payer);
  const liqeeAccount = await client.getMangoAccount(
    liqeePk,
    mangoGroup.dexProgramId,
  );
  debug('Created Liqee:', liqeePk.toBase58());

  const makerPk = await client.initMangoAccount(mangoGroup, payer);
  const makerAccount = await client.getMangoAccount(
    makerPk,
    mangoGroup.dexProgramId,
  );
  debug('Created Maker:', liqorPk.toBase58());

  await client.setStubOracle(
    mangoGroup.publicKey,
    mangoGroup.oracles[1],
    payer,
    60000,
  );

  // await runKeeper();
  debug('Depositing for liqor');
  await client.deposit(
    mangoGroup,
    liqorAccount,
    payer,
    quoteRootBank.publicKey,
    quoteNodeBanks[0].publicKey,
    quoteNodeBanks[0].vault,
    quoteWallet.address,
    100000,
  );
  debug('Depositing for liqee');
  await client.deposit(
    mangoGroup,
    liqeeAccount,
    payer,
    rootBanks[1]!.publicKey,
    rootBanks[1]!.nodeBanks[0],
    rootBanks[1]!.nodeBankAccounts[0].vault,
    btcWallet.address,
    1,
  );
  debug('Depositing for maker');
  await client.deposit(
    mangoGroup,
    makerAccount,
    payer,
    quoteRootBank.publicKey,
    quoteNodeBanks[0].publicKey,
    quoteNodeBanks[0].vault,
    quoteWallet.address,
    100000,
  );

  // await runKeeper();

  debug('Placing maker orders');
  await client.placePerpOrder(
    mangoGroup,
    makerAccount,
    mangoGroup.mangoCache,
    perpMarkets[0],
    payer,
    'sell',
    60000,
    0.0111,
    'limit',
  );

  await client.placePerpOrder(
    mangoGroup,
    makerAccount,
    mangoGroup.mangoCache,
    perpMarkets[0],
    payer,
    'buy',
    1000,
    10,
    'limit',
  );

  await client.placeSpotOrder2(
    mangoGroup,
    makerAccount,
    spotMarkets[1],
    payer,
    'buy',
    100,
    3,
    'postOnly',
  );

  debug('Placing taker order');
  await client.placePerpOrder(
    mangoGroup,
    liqeeAccount,
    mangoGroup.mangoCache,
    perpMarkets[0],
    payer,
    'buy',
    60000,
    1,
    'market',
  );

  // await runKeeper();
  await liqeeAccount.reload(connection);
  await liqorAccount.reload(connection);

  debug(
    'Liqor base',
    liqorAccount.perpAccounts[1].basePosition.toString(),
  );
  debug(
    'Liqor quote',
    liqorAccount.perpAccounts[1].quotePosition.toString(),
  );
  debug(
    'Liqee base',
    liqeeAccount.perpAccounts[1].basePosition.toString(),
  );
  debug(
    'Liqee quote',
    liqeeAccount.perpAccounts[1].quotePosition.toString(),
  );

  await client.setStubOracle(
    mangoGroup.publicKey,
    mangoGroup.oracles[1],
    payer,
    100,
  );

  cache = await mangoGroup.loadCache(connection);
  await liqeeAccount.reload(connection);
  await liqorAccount.reload(connection);

  debug(
    'Liqee Maint Health',
    liqeeAccount.getHealthRatio(mangoGroup, cache, 'Maint').toString(),
  );
  debug(
    'Liqor Maint Health',
    liqorAccount.getHealthRatio(mangoGroup, cache, 'Maint').toString(),
  );

  // Run the liquidator process for 60s
  const liquidator = spawn('yarn', ['liquidator'], {
    env: {
      CLUSTER: 'devnet',
      GROUP: 'devnet.3',
      KEYPAIR: '/Users/riordan/.config/solana/devnet.json',
      LIQOR_PK: liqorAccount.publicKey.toBase58(),
      PATH: process.env.PATH
    },
  });

  liquidator.stdout.on('data', (data) => {
    debug(`Liquidator stdout: ${data}`);
  });

  liquidator.stderr.on('data', (data) => {
    console.error(`Liquidator stderr: ${data}`);
  });

  liquidator.on('close', (code) => {
    debug(`Liquidator exited with code ${code}`);
  });

  await sleep(60000);
  liquidator.kill();

  await liqeeAccount.reload(connection);
  await liqorAccount.reload(connection);

  debug(
    'Liqee Maint Health',
    liqeeAccount.getHealthRatio(mangoGroup, cache, 'Maint').toString(),
  );
  debug('Liqee Bankrupt', liqeeAccount.isBankrupt);
  debug(
    'Liqor Maint Health',
    liqorAccount.getHealthRatio(mangoGroup, cache, 'Maint').toString(),
  );
}

testPerpLiquidationAndBankruptcy();
