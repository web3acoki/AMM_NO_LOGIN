import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint256,
  type Address,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { UNISWAP_V3_ROBINHOOD_ADDRESSES } from '../constants';
import { robinhood } from '../viem/chains/robinhood';
import {
  buildV3ApprovalTransaction,
  getV3Allowance,
} from './uniswapV3Service';
import {
  readAndValidatePonsLaunchedToken,
} from './ponsService';
import { getRuntimeRobinhoodRpcUrl } from './robinhoodRpcConfig';

/**
 * Pre-approval helper used by the graduation monitor. Actual buys and sells go
 * through the shared TradingService so nonce, quote, slippage and receipt
 * behavior stay identical to the rest of the Robinhood trading UI.
 */
export async function approvePonsRouter(args: {
  privateKey: string;
  token: Address;
  amount?: bigint;
  rpcUrl?: string;
  /** Graduation/Pons-inner flows fail closed; generic V3 outer sells opt out. */
  requireOfficialPons?: boolean;
}): Promise<Hash | null> {
  const rpcUrl = args.rpcUrl ?? getRuntimeRobinhoodRpcUrl();
  const normalizedKey = (args.privateKey.startsWith('0x') ? args.privateKey : `0x${args.privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(normalizedKey);
  const publicClient = createPublicClient({ chain: robinhood, transport: http(rpcUrl) });
  const requireOfficialPons = args.requireOfficialPons !== false;
  if (requireOfficialPons) {
    await readAndValidatePonsLaunchedToken(publicClient, args.token);
  }
  const required = args.amount ?? maxUint256;
  const allowance = await getV3Allowance(
    publicClient,
    args.token,
    account.address,
    UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
  );
  if (allowance >= required) return null;

  // Re-read owner-mutable dexId configuration immediately before granting the
  // official Router02 allowance in Pons-specific flows. Generic Uniswap V3
  // outer-market tokens are not required to originate from the launchpad.
  if (requireOfficialPons) {
    await readAndValidatePonsLaunchedToken(publicClient, args.token);
  }
  const walletClient = createWalletClient({ account, chain: robinhood, transport: http(rpcUrl) });
  const transaction = buildV3ApprovalTransaction(
    args.token,
    maxUint256,
    UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
  );
  const hash = await walletClient.sendTransaction({ account, chain: robinhood, ...transaction });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`Router 授权失败: ${hash}`);
  return hash;
}
