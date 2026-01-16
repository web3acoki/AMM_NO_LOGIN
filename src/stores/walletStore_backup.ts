import { defineStore } from 'pinia';
import { createWalletClient, createPublicClient, http, fallback, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { erc20Abi } from '../viem/abis/erc20';
import { WalletDetector } from '../utils/walletDetector';

type LocalWallet = { 
  address: string; 
  encrypted?: string;
  nativeBalance?: string;
  tokenBalance?: string;
};

async function sha256(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const useWalletStore = defineStore('wallet', {
  state: () => ({
    connectedAddress: '' as string,
    connectedWalletType: '' as string,
    localWallets: [] as LocalWallet[],
    walletDetector: WalletDetector.getInstance(),
  }),
  actions: {
    async init() {
      const saved = localStorage.getItem('local-wallets');
      if (saved) this.localWallets = JSON.parse(saved);
    },
    persist() { localStorage.setItem('local-wallets', JSON.stringify(this.localWallets)); },

    async connectWallet(walletType: 'metamask' | 'okx' | 'walletconnect') {
      try {
        // 使用新的钱包检测器
        if (!this.walletDetector.isWalletAvailable(walletType)) {
          alert(`未检测到 ${walletType === 'metamask' ? 'MetaMask' : 'OKX Wallet'} 钱包，请先安装对应扩展`);
          return;
        }

        const result = await this.walletDetector.connectWallet(walletType);
        this.connectedAddress = result.address;
        this.connectedWalletType = result.walletType;
        
        console.log('钱包连接成功:', result);
      } catch (error: any) {
        console.error('连接钱包失败:', error);
        alert(error.message || '连接钱包失败，请重试');
      }
    },

    // 保持向后兼容
    async connectInjected() {
      await this.connectWallet('metamask');
    },

    async disconnectWallet() {
      if (this.connectedWalletType) {
        await this.walletDetector.disconnectWallet(this.connectedWalletType);
      }
      this.connectedAddress = '';
      this.connectedWalletType = '';
      console.log('钱包已断开连接');
    },

    async generateLocalWallets(count: number) {
      for (let i = 0; i < count; i++) {
        // 仅用于占位：随机私钥。正式场景请安全生成并加密保存到 IndexedDB。
        const random = crypto.getRandomValues(new Uint8Array(32));
        const privateKey = `0x${Array.from(random).map(b => b.toString(16).padStart(2, '0')).join('')}`;
        const account = privateKeyToAccount(privateKey as `0x${string}`);
        const encrypted = await sha256(privateKey); // 占位：实际应使用 AES 加密
        this.localWallets.push({ address: account.address, encrypted });
      }
      this.persist();
    },

    removeLocalWallet(addr: string) {
      this.localWallets = this.localWallets.filter((w) => w.address !== addr);
      this.persist();
    },

    clearLocalWallets() {
      this.localWallets = [];
      this.persist();
    },

    async exportPrivateKeys() {
      if (this.localWallets.length === 0) {
        alert('没有可导出的钱包');
        return;
      }

      try {
        // 创建导出数据
        const exportData = {
          timestamp: new Date().toISOString(),
          walletCount: this.localWallets.length,
          wallets: this.localWallets.map((wallet, index) => ({
            index: index + 1,
            address: wallet.address,
            privateKey: wallet.encrypted || '未存储私钥',
            note: '请妥善保管私钥，不要泄露给他人'
          }))
        };

        // 创建 JSON 文件内容
        const jsonContent = JSON.stringify(exportData, null, 2);
        
        // 创建 CSV 文件内容
        const csvHeader = '序号,钱包地址,私钥,备注\n';
        const csvRows = this.localWallets.map((wallet, index) => 
          `${index + 1},"${wallet.address}","${wallet.encrypted || '未存储私钥'}","请妥善保管私钥"`
        );
        const csvContent = csvHeader + csvRows.join('\n');

        // 创建下载链接
        const jsonBlob = new Blob([jsonContent], { type: 'application/json' });
        const csvBlob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        
        const jsonUrl = URL.createObjectURL(jsonBlob);
        const csvUrl = URL.createObjectURL(csvBlob);

        // 创建下载链接
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        
        // 下载 JSON 文件
        const jsonLink = document.createElement('a');
        jsonLink.href = jsonUrl;
        jsonLink.download = `wallets-private-keys-${timestamp}.json`;
        document.body.appendChild(jsonLink);
        jsonLink.click();
        document.body.removeChild(jsonLink);

        // 下载 CSV 文件
        const csvLink = document.createElement('a');
        csvLink.href = csvUrl;
        csvLink.download = `wallets-private-keys-${timestamp}.csv`;
        document.body.appendChild(csvLink);
        csvLink.click();
        document.body.removeChild(csvLink);

        // 清理 URL 对象
        setTimeout(() => {
          URL.revokeObjectURL(jsonUrl);
          URL.revokeObjectURL(csvUrl);
        }, 1000);

        alert(`成功导出 ${this.localWallets.length} 个钱包的私钥信息！\n\n已下载 JSON 和 CSV 两种格式的文件。\n\n⚠️ 请妥善保管私钥文件，不要泄露给他人！`);
      } catch (error) {
        console.error('导出私钥失败:', error);
        throw new Error('导出私钥失败，请重试');
      }
    },

    getClient(rpcUrl?: string) {
      return createWalletClient({ chain: bscTestnet, transport: fallback([http(rpcUrl ?? 'https://bsc-testnet.publicnode.com')]) });
    },

    getPublicClient(rpcUrl?: string) {
      return createPublicClient({ chain: bscTestnet, transport: fallback([http(rpcUrl ?? 'https://bsc-testnet.publicnode.com')]) });
    },

    async refreshAllBalances() {
      const publicClient = this.getPublicClient();
      
      for (const wallet of this.localWallets) {
        try {
          // 读取原生币余额
          const nativeBalance = await publicClient.getBalance({ address: wallet.address as `0x${string}` });
          wallet.nativeBalance = formatEther(nativeBalance);
          
          // 代币余额暂时设为占位符，需要指定代币合约地址
          wallet.tokenBalance = '-';
        } catch (error) {
          console.error(`Failed to fetch balance for ${wallet.address}:`, error);
          wallet.nativeBalance = 'Error';
          wallet.tokenBalance = 'Error';
        }
      }
      
      this.persist();
    },

    async refreshTokenBalance(tokenAddress: string) {
      const publicClient = this.getPublicClient();
      
      for (const wallet of this.localWallets) {
        try {
          const balance = await publicClient.readContract({
            address: tokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [wallet.address as `0x${string}`]
          });
          // 简化：假设 18 位小数
          wallet.tokenBalance = formatEther(balance);
        } catch (error) {
          console.error(`Failed to fetch token balance for ${wallet.address}:`, error);
          wallet.tokenBalance = 'Error';
        }
      }
      
      this.persist();
    },
  },
});
