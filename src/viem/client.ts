import { createPublicClient, createWalletClient, http, fallback } from 'viem';
import { bscTestnet } from 'viem/chains';

export function getPublicClient(rpc?: string) {
  return createPublicClient({ chain: bscTestnet, transport: fallback([http(rpc ?? 'https://bsc-testnet.publicnode.com')]) });
}

export function getWalletClient(rpc?: string) {
  return createWalletClient({ chain: bscTestnet, transport: fallback([http(rpc ?? 'https://bsc-testnet.publicnode.com')]) });
}


