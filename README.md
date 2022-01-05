# !!Warning!!
> This liquidator has a bug when checking advanced order triggers, so please run it with `CHECK_TRIGGERS=0`.
> The bug should be addressed soon, normal liquidation logic doesn't suffer from this bug.

# liquidator-v3
A script for liquidating undercollateralized account on Mango Markets

## Setup
To run the liquidator you will need:
* A Solana account with some SOL deposited to cover transaction fees
* A Mango Account with some collateral deposited
* Your wallet keypair saved as a JSON file
* `node` and `yarn`
* A clone of this repository
* Dependencies installed with `yarn install`

## Environment Variables
| Variable | Default | Description |
| -------- | ------- | ----------- |
| `CLUSTER` | `mainnet` | The Solana cluster to use |
| `ENDPOINT_URL` | `https://solana-api.projectserum.com` | Your RPC node endpoint |
| `KEYPAIR` | `${HOME}/.config/solana/id.json` | The location of your wallet keypair |
| `GROUP` | `mainnet.1` | Name of the group in ids.json to run the Liquidator against |
| `TARGETS` | `0 0 0 0 0 0 0 0` | Space separated list of the amount of each asset to maintain when rebalancing |
| `INTERVAL` | `3500` | Milliseconds to wait before checking for sick accounts |
| `INTERVAL_ACCOUNTS` | `120000` | Milliseconds to wait before reloading all Mango accounts |
| `INTERVAL_WEBSOCKET` | `300000` | Milliseconds to wait before reconnecting to the websocket |
| `LIQOR_PK` | N/A | Liqor Mango account Public Key, by default uses the largest value account owned by the keypair |
| `WEBHOOK_URL` | N/A | Discord webhook URL to post liquidation events and errors to |

You can add these varibles to a `.env` file in the project root to load automatically on liquidator startup. For example:
```bash
ENDPOINT_URL=https://solana-api.projectserum.com
KEYPAIR=${HOME}/.config/solana/my-keypair.json 
TARGETS=500 0.1 0.75 0 0 0 0 0
```
## Rebalancing
The liquidator will attempt to close all perp positions, and balance the tokens in the liqor account after each liquidation. By default it will sell all token assets into USDC. You can choose to maintain a certain amount of each asset through this process by editing the value in the `TARGETS` environment variable at the position of the asset. You can find the order of the assets in the 'oracles' property of the group in [ids.json](https://github.com/blockworks-foundation/mango-client-v3/blob/main/src/ids.json#L81) The program will attempt to make buy/sell orders during balancing to maintain this level.

## Run
```
yarn liquidator
```