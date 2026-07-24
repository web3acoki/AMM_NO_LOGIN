import { defineChain } from 'viem';
import {
  ROBINHOOD_ARROW_RPC_URL,
  ROBINHOOD_ARROW_WS_URL,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_OFFICIAL_RPC_URL,
  ROBINHOOD_SEQUENCER_RPC_URL,
} from '../../constants';

export const ROBINHOOD_RPC_URLS = {
  official: ROBINHOOD_OFFICIAL_RPC_URL,
  sequencer: ROBINHOOD_SEQUENCER_RPC_URL,
  arrow: ROBINHOOD_ARROW_RPC_URL,
  arrowWebSocket: ROBINHOOD_ARROW_WS_URL,
} as const;

export const robinhood = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  // Robinhood's sequencer currently advances block timestamps every ~100 ms.
  // Without this field viem assumes a 12 s Ethereum block time and clamps its
  // receipt polling to 4 s, adding up to roughly one 4 s poll cycle even after
  // a transaction is already included.
  // viem applies a safe 500 ms minimum polling interval for a 100 ms chain.
  blockTime: 100,
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [ROBINHOOD_OFFICIAL_RPC_URL, ROBINHOOD_ARROW_RPC_URL],
      webSocket: [ROBINHOOD_ARROW_WS_URL],
    },
    public: {
      http: [ROBINHOOD_OFFICIAL_RPC_URL, ROBINHOOD_ARROW_RPC_URL],
      webSocket: [ROBINHOOD_ARROW_WS_URL],
    },
  },
  blockExplorers: {
    default: {
      name: 'Robinhood Chain Blockscout',
      url: ROBINHOOD_EXPLORER_URL,
      apiUrl: `${ROBINHOOD_EXPLORER_URL}/api`,
    },
  },
  sourceId: 1,
});

// Compatibility alias for call sites that prefer an explicit suffix.
export const robinhoodChain = robinhood;
