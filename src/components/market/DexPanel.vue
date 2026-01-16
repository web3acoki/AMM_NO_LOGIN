<template>
  <!-- <div>
    <div class="d-flex justify-content-between align-items-center mb-2">
      <h2 class="h6 mb-0">DEX 面板</h2>
    </div>
    <div class="row g-2">
      <div class="col-12">
        <label class="form-label">Router 地址（BSC Testnet 默认）</label>
        <input class="form-control" v-model="router" placeholder="0x..." />
      </div>
      <div class="col-6">
        <label class="form-label">TokenA</label>
        <input class="form-control" v-model="tokenA" placeholder="0x..." />
      </div>
      <div class="col-6">
        <label class="form-label">TokenB</label>
        <input class="form-control" v-model="tokenB" placeholder="0x..." />
      </div>
      <div class="col-6">
        <label class="form-label">输入数量（TokenA）</label>
        <input type="number" class="form-control" v-model.number="amountIn" />
      </div>
      <div class="col-6">
        <label class="form-label">输出预估（TokenB）</label>
        <input class="form-control" :value="amountOutDisplay" disabled />
      </div>
      <div class="col-12 d-flex gap-2">
        <button class="btn btn-outline-primary" @click="quote">读取价格</button>
        <button class="btn btn-outline-secondary" @click="approve">Approve</button>
        <button class="btn btn-primary" @click="swap">SwapExact</button>
      </div>
    </div>
  </div> -->
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { pancakeV2RouterAbi } from '../../viem/abis/pancakeV2';
import { erc20Abi } from '../../viem/abis/erc20';
import { getPublicClient, getWalletClient } from '../../viem/client';
import { useChainStore } from '../../stores/chainStore';
import { storeToRefs } from 'pinia';

const chainStore = useChainStore();
const { rpcUrl } = storeToRefs(chainStore);

// BSC Testnet 默认 Router（PancakeSwap v2）
const router = ref<string>('0x3E38E2b2c9D6b6F7C0A7a7D54d80E9A5e6C0A5aF'); // 占位，使用者可替换
const tokenA = ref<string>('');
const tokenB = ref<string>('');
const amountIn = ref<number>(0.01);
const lastQuote = ref<string>('-');

const amountOutDisplay = computed(() => lastQuote.value);

async function quote() {
  if (!tokenA.value || !tokenB.value) return;
  const pub = getPublicClient(rpcUrl.value);
  try {
    // 简化：默认 token A/B 都是 18 位
    const decimals = 18n;
    const amount = BigInt(Math.floor(amountIn.value * 10 ** 6)) * (10n ** (decimals - 6n));
    const amounts = await pub.readContract({
      address: router.value as `0x${string}`,
      abi: pancakeV2RouterAbi,
      functionName: 'getAmountsOut',
      args: [amount, [tokenA.value as `0x${string}`, tokenB.value as `0x${string}`]],
    });
    const out = amounts[amounts.length - 1];
    lastQuote.value = Number(out) / 1e18 + '';
  } catch (e) {
    lastQuote.value = '读取失败';
    console.error(e);
  }
}

async function approve() {
  // 仅演示：调用 approve，需连接钱包并切到对应网络
  try {
    const wallet = getWalletClient(rpcUrl.value);
    await wallet.writeContract({
      address: tokenA.value as `0x${string}`,
      abi: erc20Abi,
      functionName: 'approve',
      args: [router.value as `0x${string}`, 2n ** 256n - 1n],
      account: (window as any).ethereum?.selectedAddress,
    } as any);
    alert('approve 已提交');
  } catch (e) {
    alert('approve 失败，请查看控制台');
    console.error(e);
  }
}

async function swap() {
  try {
    const wallet = getWalletClient(rpcUrl.value);
    const amount = BigInt(Math.floor(amountIn.value * 10 ** 6)) * (10n ** (18n - 6n));
    const minOut = 0n; // 占位，生产中请加入滑点计算
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 10);
    await wallet.writeContract({
      address: router.value as `0x${string}`,
      abi: pancakeV2RouterAbi,
      functionName: 'swapExactTokensForTokens',
      args: [amount, minOut, [tokenA.value as `0x${string}`, tokenB.value as `0x${string}`], (window as any).ethereum?.selectedAddress, deadline],
      account: (window as any).ethereum?.selectedAddress,
    } as any);
    alert('swap 已提交');
  } catch (e) {
    alert('swap 失败，请查看控制台');
    console.error(e);
  }
}
</script>

