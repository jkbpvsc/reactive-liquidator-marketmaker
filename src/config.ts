import fs from "fs";
import path from "path";

import * as Env from 'dotenv';
import envExpand from 'dotenv-expand';
import {Commitment} from "@solana/web3.js";
envExpand(Env.config());

export const INTERVAL = parseInt(process.env.INTERVAL || '3500');
export const REFRESH_ACCOUNT_INTERVAL = parseInt(process.env.INTERVAL_ACCOUNTS || '120000');
export const REFRESH_WEBSOCKET_INTERVAL = parseInt(process.env.INTERVAL_WEBSOCKET || '300000',);
export const CHECK_TRIGGERS = process.env.CHECK_TRIGGERS ? process.env.CHECK_TRIGGERS === 'true' : true;
export const HEALTH_THRESHOLD = process.env.HEALTH_THRESHOLD ? Number.parseInt(process.env.HEALTH_THRESHOLD) : 10;
export const TX_CACHE_RESET_DELAY = parseInt(process.env.CACHE_RESET_DELAY || '300000');
export const TARGETS = process.env.TARGETS
    ? process.env.TARGETS.split(' ').map((s) => parseFloat(s))
    : [0, 0, 0, 0, 0, 0, 0, 0, 0];

const PARAMS_FILE_NAME = process.env.PARAMS || 'default.json';
export const MM_PARAMS = JSON.parse(
    fs.readFileSync(
        path.resolve(__dirname, `../params/${PARAMS_FILE_NAME}`),
        'utf-8',
    ),
);

export enum BotModes {
    LiquidatorOnly = 0,
    MarketMakerOnly = 1,
    LiquidatorAndMarketMaker
}

/**
 * Modes:
 * 0 - Liquidator Only
 * 1 - Market Maker Only
 * 2 - Liquidator and Market Maker
 */
export const BOT_MODE: BotModes = process.env.BOT_MODE ? parseInt(process.env.BOT_MODE) : BotModes.LiquidatorOnly

export const COMMITMENT: Commitment = process.env.COMMITMENT as Commitment || 'processed';

