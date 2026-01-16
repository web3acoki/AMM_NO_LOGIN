// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title BatchTransfer
 * @dev 智能批量转账合约，支持自动检测代币类型
 */
contract BatchTransfer {
    
    /**
     * @dev 智能批量转账 - 自动检测代币类型
     * @param token 代币合约地址，如果为address(0)则处理原生代币
     * @param recipients 接收者地址数组
     * @param amounts 对应的转账金额数组（单位：wei）
     */
    function batchTransfer(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external payable {
        require(recipients.length == amounts.length, "Arrays length mismatch");
        require(recipients.length > 0, "Empty recipients array");
        
        // 自动检测代币类型
        if (token == address(0)) {
            // 处理原生代币
            _batchTransferNative(recipients, amounts);
        } else {
            // 处理ERC20代币
            _batchTransferToken(token, recipients, amounts);
        }
    }
    
    /**
     * @dev 内部函数：批量转账原生代币
     */
    function _batchTransferNative(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) internal {
        uint256 totalAmount = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            totalAmount += amounts[i];
        }
        
        require(msg.value >= totalAmount, "Insufficient native token sent");
        
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "Invalid recipient address");
            require(amounts[i] > 0, "Invalid amount");
            
            (bool success, ) = recipients[i].call{value: amounts[i]}("");
            require(success, "Native transfer failed");
        }
        
        // 退还多余的代币
        if (msg.value > totalAmount) {
            (bool success, ) = msg.sender.call{value: msg.value - totalAmount}("");
            require(success, "Refund failed");
        }
    }
    
    /**
     * @dev 内部函数：批量转账ERC20代币
     */
    function _batchTransferToken(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) internal {
        require(token != address(0), "Invalid token address");
        
        // 计算总金额
        uint256 totalAmount = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            totalAmount += amounts[i];
        }
        
        // 从调用者转账代币到合约
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)",
                msg.sender,
                address(this),
                totalAmount
            )
        );
        require(success, "Token transfer failed");
        
        // 批量转账给接收者
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "Invalid recipient address");
            require(amounts[i] > 0, "Invalid amount");
            
            (success, data) = token.call(
                abi.encodeWithSignature(
                    "transfer(address,uint256)",
                    recipients[i],
                    amounts[i]
                )
            );
            require(success, "Token batch transfer failed");
        }
    }
    
    /**
     * @dev 检测代币类型
     * @param token 代币合约地址
     * @return tokenType 代币类型：0=原生代币，1=ERC20代币
     */
    function getTokenType(address token) external pure returns (uint8 tokenType) {
        if (token == address(0)) {
            return 0; // 原生代币
        } else {
            return 1; // ERC20代币
        }
    }
    
    /**
     * @dev 检测代币是否为ERC20
     * @param token 代币合约地址
     * @return isERC20 是否为ERC20代币
     */
    function isERC20Token(address token) external view returns (bool isERC20) {
        if (token == address(0)) {
            return false;
        }
        
        // 尝试调用ERC20的balanceOf方法检测
        (bool success, ) = token.staticcall(
            abi.encodeWithSignature("balanceOf(address)", address(this))
        );
        
        return success;
    }
    
    /**
     * @dev 获取代币余额
     * @param token 代币合约地址，address(0)表示原生代币
     * @param account 账户地址
     * @return balance 代币余额
     */
    function getTokenBalance(address token, address account) external view returns (uint256 balance) {
        if (token == address(0)) {
            // 原生代币余额
            return account.balance;
        } else {
            // ERC20代币余额
            (bool success, bytes memory data) = token.staticcall(
                abi.encodeWithSignature("balanceOf(address)", account)
            );
            require(success, "Failed to get token balance");
            return abi.decode(data, (uint256));
        }
    }
    
    /**
     * @dev 获取合约的原生代币余额
     */
    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
    
    /**
     * @dev 获取合约的ERC20代币余额
     * @param token ERC20代币合约地址
     */
    function getTokenBalance(address token) external view returns (uint256) {
        require(token != address(0), "Invalid token address");
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("balanceOf(address)", address(this))
        );
        require(success, "Failed to get token balance");
        return abi.decode(data, (uint256));
    }
    
    // 保留原有的独立函数，用于向后兼容
    function batchTransferNative(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external payable {
        _batchTransferNative(recipients, amounts);
    }
    
    function batchTransferToken(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        _batchTransferToken(token, recipients, amounts);
    }
}