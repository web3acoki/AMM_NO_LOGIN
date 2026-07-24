import { ROBINHOOD_OFFICIAL_RPC_URL } from '../constants';

export type CreateTokenNetwork = 'bscMainnet' | 'bscTestnet' | 'robinhood';

/**
 * Pons launchToken performs a large stateful eth_call before it is signed.
 * The authenticated trading RPC can broadcast ordinary transactions quickly,
 * but currently returns a false revert for launchToken when developerBuy > 0.
 * Keep token creation on Robinhood's official RPC while trading continues to
 * use the independently configured runtime endpoint.
 */
export const ROBINHOOD_CREATE_TOKEN_RPC_URL = ROBINHOOD_OFFICIAL_RPC_URL;

export function resolveCreateTokenRpcUrl(
  network: CreateTokenNetwork,
  selectedRpcUrl: string,
): string {
  return network === 'robinhood'
    ? ROBINHOOD_CREATE_TOKEN_RPC_URL
    : selectedRpcUrl;
}
