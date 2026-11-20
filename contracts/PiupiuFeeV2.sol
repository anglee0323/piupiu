// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IAgentId {
    function balanceOf(address owner) external view returns (uint256);
}

/// @title Piupiu 交易手续费收款合约 V2（Agent ID 持有者专用）
/// @notice 只做两件事：
///         1. 检查付款钱包持有 Agent ID（name.ai，BNB 智能链 ERC-721）；没有就拒绝；
///         2. 收到的 BNB 当场全额转给 treasury。
///         合约自己不留钱、不碰任何代币、没有管理员、不可升级；treasury 部署时写死（immutable），之后谁都改不了。
///         没有 Agent ID 的钱包继续使用 V1（0x208ceCa4E6Dde0D7deE16707a6209257d54B2615），行为不变。
/// @dev Owner 权限披露：无 owner；无增发、无改费率、无暂停、无冻结、无提走用户资产的入口；不接收任何授权。
contract PiupiuFeeV2 {
    /// Agent ID（SPACE ID Agent ID，符号 AI，ERC-721，不可转让）
    address public constant AGENT_ID = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;

    address payable public immutable treasury;

    /// @param payer 付费的钱包；ref 对应的订单（Piupiu 本地记录的订单编号摘要，便于对账）
    event Paid(address indexed payer, uint256 amount, bytes32 indexed ref);

    error NoAgentId();
    error ZeroAmount();
    error ForwardFailed();
    error UsePay();

    constructor(address payable treasury_) {
        require(treasury_ != address(0), "treasury=0");
        treasury = treasury_;
    }

    /// 付款钱包是否持有 Agent ID（界面和脚本预检用）
    function holdsAgentId(address who) public view returns (bool) {
        return IAgentId(AGENT_ID).balanceOf(who) > 0;
    }

    function pay(bytes32 ref) external payable {
        if (!holdsAgentId(msg.sender)) revert NoAgentId();
        if (msg.value == 0) revert ZeroAmount();
        (bool ok, ) = treasury.call{value: msg.value}("");
        if (!ok) revert ForwardFailed();
        emit Paid(msg.sender, msg.value, ref);
    }

    /// 直接转账（不带 ref）一律拒绝，避免误转进来的钱说不清来源
    receive() external payable {
        revert UsePay();
    }
}
