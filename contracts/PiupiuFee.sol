// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Piupiu 交易手续费收款合约
/// @notice 只做一件事：收到的 BNB 当场全额转给 treasury，合约自己不留钱、不碰任何代币、没有管理员。
///         treasury 部署时写死（immutable），之后谁都改不了。
contract PiupiuFee {
    address payable public immutable treasury;

    /// @param payer 付费的钱包；ref 对应的订单（Piupiu 本地记录的订单编号摘要，便于对账）
    event Paid(address indexed payer, uint256 amount, bytes32 indexed ref);

    constructor(address payable treasury_) {
        require(treasury_ != address(0), "treasury=0");
        treasury = treasury_;
    }

    function pay(bytes32 ref) external payable {
        require(msg.value > 0, "amount=0");
        (bool ok, ) = treasury.call{value: msg.value}("");
        require(ok, "forward failed");
        emit Paid(msg.sender, msg.value, ref);
    }

    /// 直接转账（不带 ref）一律拒绝，避免误转进来的钱说不清来源
    receive() external payable {
        revert("use pay(ref)");
    }
}
