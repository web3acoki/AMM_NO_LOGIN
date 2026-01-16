// 钱包检测和连接工具
export interface WalletInfo {
  name: string;
  provider: any;
  isConnected: boolean;
}

export class WalletDetector {
  private static instance: WalletDetector;
  private wallets: Map<string, WalletInfo> = new Map();

  static getInstance(): WalletDetector {
    if (!WalletDetector.instance) {
      WalletDetector.instance = new WalletDetector();
    }
    return WalletDetector.instance;
  }

  constructor() {
    this.detectWallets();
  }

  private detectWallets() {
    try {
      // 检测 MetaMask
      if ((window as any).ethereum?.isMetaMask) {
        this.wallets.set('metamask', {
          name: 'MetaMask',
          provider: (window as any).ethereum,
          isConnected: false
        });
      }

      // 检测 OKX Wallet - 添加错误处理
      try {
        if ((window as any).okxwallet) {
          this.wallets.set('okx', {
            name: 'OKX Wallet',
            provider: (window as any).okxwallet,
            isConnected: false
          });
        }
      } catch (error) {
        console.warn('OKX钱包检测失败，可能是扩展冲突:', error);
      }
    } catch (error) {
      console.warn('钱包检测过程中出现错误:', error);
    }

    // 检测 Coinbase Wallet
    if ((window as any).ethereum?.isCoinbaseWallet) {
      this.wallets.set('coinbase', {
        name: 'Coinbase Wallet',
        provider: (window as any).ethereum,
        isConnected: false
      });
    }

    // 检测 Trust Wallet
    if ((window as any).ethereum?.isTrust) {
      this.wallets.set('trust', {
        name: 'Trust Wallet',
        provider: (window as any).ethereum,
        isConnected: false
      });
    }

    // 检测多个钱包的情况
    if ((window as any).ethereum?.providers) {
      const providers = (window as any).ethereum.providers;
      
      // 查找 MetaMask
      const metamaskProvider = providers.find((p: any) => p.isMetaMask);
      if (metamaskProvider && !this.wallets.has('metamask')) {
        this.wallets.set('metamask', {
          name: 'MetaMask',
          provider: metamaskProvider,
          isConnected: false
        });
      }

      // 查找 OKX
      const okxProvider = providers.find((p: any) => p.isOkxWallet);
      if (okxProvider && !this.wallets.has('okx')) {
        this.wallets.set('okx', {
          name: 'OKX Wallet',
          provider: okxProvider,
          isConnected: false
        });
      }

      // 查找 Coinbase
      const coinbaseProvider = providers.find((p: any) => p.isCoinbaseWallet);
      if (coinbaseProvider && !this.wallets.has('coinbase')) {
        this.wallets.set('coinbase', {
          name: 'Coinbase Wallet',
          provider: coinbaseProvider,
          isConnected: false
        });
      }

      // 查找 Trust
      const trustProvider = providers.find((p: any) => p.isTrust);
      if (trustProvider && !this.wallets.has('trust')) {
        this.wallets.set('trust', {
          name: 'Trust Wallet',
          provider: trustProvider,
          isConnected: false
        });
      }
    }
  }

  getAvailableWallets(): WalletInfo[] {
    return Array.from(this.wallets.values());
  }

  getWalletById(id: string): WalletInfo | undefined {
    return this.wallets.get(id);
  }

  async connectWallet(walletId: string): Promise<{ address: string; walletType: string }> {
    const wallet = this.wallets.get(walletId);
    if (!wallet) {
      throw new Error(`钱包 ${walletId} 未找到`);
    }

    try {
      // 检查钱包是否可用
      if (!wallet.provider || typeof wallet.provider.request !== 'function') {
        throw new Error(`钱包 ${wallet.name} 不可用，请检查扩展是否正确安装`);
      }

      // 检查是否已经连接
      const accounts = await wallet.provider.request({ method: 'eth_accounts' });
      if (accounts && accounts.length > 0) {
        wallet.isConnected = true;
        return {
          address: accounts[0],
          walletType: walletId
        };
      }

      // 请求连接
      const newAccounts = await wallet.provider.request({ 
        method: 'eth_requestAccounts' 
      });
      
      if (newAccounts && newAccounts.length > 0) {
        wallet.isConnected = true;
        return {
          address: newAccounts[0],
          walletType: walletId
        };
      }

      throw new Error('未获取到钱包地址');
    } catch (error: any) {
      console.error(`连接 ${wallet.name} 失败:`, error);
      
      // 处理扩展冲突错误
      if (error.message?.includes('message channel closed') || 
          error.message?.includes('chrome-extension')) {
        throw new Error(`钱包扩展冲突，请尝试：\n1. 刷新页面\n2. 暂时禁用其他钱包扩展\n3. 使用无痕模式`);
      }
      
      if (error.code === 4001) {
        throw new Error('用户拒绝了连接请求');
      } else if (error.code === -32002) {
        throw new Error('连接请求已在进行中，请检查钱包弹窗');
      } else if (error.message?.includes('User rejected')) {
        throw new Error('用户拒绝了连接请求');
      } else if (error.message?.includes('not found')) {
        throw new Error(`钱包 ${wallet.name} 未找到，请检查扩展是否正确安装`);
      } else {
        throw new Error(`连接失败: ${error.message || '未知错误'}`);
      }
    }
  }

  async disconnectWallet(walletId: string): Promise<void> {
    const wallet = this.wallets.get(walletId);
    if (wallet) {
      wallet.isConnected = false;
    }
  }

  isWalletAvailable(walletId: string): boolean {
    return this.wallets.has(walletId);
  }

  hasWalletConflict(): boolean {
    return this.wallets.size > 1;
  }

  getWalletConflictInfo(): string[] {
    return Array.from(this.wallets.keys());
  }
}
