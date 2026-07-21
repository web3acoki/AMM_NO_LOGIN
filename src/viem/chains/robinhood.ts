import { defineChain } from 'viem';
import {
  ROBINHOOD_ARROW_RPC_URL,
  ROBINHOOD_ARROW_WS_URL,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_OFFICIAL_RPC_URL,
} from '../../constants';

export const ROBINHOOD_RPC_URLS = {
  official: ROBINHOOD_OFFICIAL_RPC_URL,
  arrow: ROBINHOOD_ARROW_RPC_URL,
  arrowWebSocket: ROBINHOOD_ARROW_WS_URL,
} as const;

export const robinhood = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
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
