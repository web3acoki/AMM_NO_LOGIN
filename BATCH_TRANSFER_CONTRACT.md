# 批量转账合约部署说明

## 合约功能

`BatchTransfer.sol` 合约提供了真正的批量转账功能，支持：

1. **批量转账原生代币** - 一次授权向多个地址转账BNB/OKB等
2. **批量转账ERC20代币** - 一次授权向多个地址转账ERC20代币

## 合约地址配置

需要在 `src/stores/walletStore.ts` 中配置各网络的合约地址：

```typescript
const BATCH_TRANSFER_CONTRACTS = {
  56: '0x你的BSC主网合约地址',     // BSC主网
  97: '0x你的BSC测试网合约地址',   // BSC测试网  
  66: '0x你的OKX链合约地址',      // OKX Chain
};
```

## 部署步骤

### 1. 编译合约

```bash
# 使用Hardhat或Remix编译合约
npx hardhat compile
```

### 2. 部署到各网络

#### BSC测试网部署
```bash
# 使用Hardhat部署
npx hardhat run scripts/deploy.js --network bscTestnet
```

#### BSC主网部署
```bash
npx hardhat run scripts/deploy.js --network bscMainnet
```

#### OKX Chain部署
```bash
npx hardhat run scripts/deploy.js --network okxChain
```

### 3. 更新合约地址

将部署得到的合约地址更新到 `BATCH_TRANSFER_CONTRACTS` 配置中。

## 合约优势

1. **真正的批量转账** - 用户只需授权一次，合约自动向所有地址转账
2. **Gas费用优化** - 比多次单独转账更节省Gas
3. **原子性操作** - 要么全部成功，要么全部失败
4. **支持多网络** - 支持BSC、OKX Chain等网络

## 使用方法

1. 用户点击"批量转账"按钮
2. 系统优先尝试合约批量转账
3. 如果合约不可用，回退到连续转账模式
4. 合约批量转账只需用户授权一次

## 注意事项

1. 需要先部署合约到各网络
2. 合约地址需要正确配置
3. 用户需要有足够的Gas费用
4. 合约需要足够的原生代币余额

## 技术实现

- 使用Solidity 0.8.0+
- 支持动态数组参数
- 包含错误处理和余额检查
- 支持代币退还机制
