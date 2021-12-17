#!/usr/bin/bash
DEBUG=* node --max-old-space-size=4096 -- node_modules/ts-node/dist/bin.js -P tsconfig.json src/bot.ts