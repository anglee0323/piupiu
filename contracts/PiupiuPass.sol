// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IAgentId {
    function balanceOf(address owner) external view returns (uint256);
}

/// @title Piupiu Pass：Agent ID 持有者的免费通行证（不可转让）
/// @notice 持有 Agent ID（name.ai，BNB 智能链 ERC-721）的钱包调用 `claim()` 领取一枚，一个地址一枚、不可转让。
///         通行证只是链上的一枚徽章，不附带任何收益、分红或其他金融权利；领取免费，只需支付网络费。
///         图片和元数据全部由合约在链上生成，不依赖任何外部存储。
/// @dev Owner 权限披露：无 owner、无管理员、无升级入口、无暂停、无增发（只有持有者本人能为自己铸造）、
///      不收款（没有 payable 函数，也不接收 BNB）、不接收任何代币授权。部署者对合约没有任何权限。
///      实现了 ERC-721（含元数据）与 ERC-5192（锁定 / 灵魂绑定）；所有转移和授权函数一律回滚。
contract PiupiuPass {
    /// Agent ID（SPACE ID Agent ID，符号 AI，ERC-721，不可转让）
    address public constant AGENT_ID = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;

    string public constant name = "Piupiu Pass";
    string public constant symbol = "PPASS";

    uint256 public totalSupply;
    mapping(uint256 => address) private _ownerOf;
    /// 某个地址领到的通行证编号（0 = 还没领）
    mapping(address => uint256) public passOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    /// ERC-5192：通行证领取即锁定
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);
    event Claimed(address indexed holder, uint256 indexed tokenId);

    error NoAgentId();
    error AlreadyClaimed();
    error Soulbound();
    error NonexistentToken();

    /// 领取通行证：调用者必须持有 Agent ID，且还没领过。免费，不带参数。
    function claim() external returns (uint256 id) {
        if (IAgentId(AGENT_ID).balanceOf(msg.sender) == 0) revert NoAgentId();
        if (passOf[msg.sender] != 0) revert AlreadyClaimed();
        id = ++totalSupply;
        _ownerOf[id] = msg.sender;
        passOf[msg.sender] = id;
        emit Transfer(address(0), msg.sender, id);
        emit Locked(id);
        emit Claimed(msg.sender, id);
    }

    /// 付款 / 查询用：某个地址是否持有 Agent ID
    function holdsAgentId(address who) external view returns (bool) {
        return IAgentId(AGENT_ID).balanceOf(who) > 0;
    }

    // ---------------------------------------------------------------- ERC-721（只读部分）
    function balanceOf(address owner_) external view returns (uint256) {
        require(owner_ != address(0), "zero address");
        return passOf[owner_] == 0 ? 0 : 1;
    }

    function ownerOf(uint256 tokenId) public view returns (address o) {
        o = _ownerOf[tokenId];
        if (o == address(0)) revert NonexistentToken();
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    /// ERC-5192
    function locked(uint256 tokenId) external view returns (bool) {
        ownerOf(tokenId);
        return true;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 // ERC-165
            || id == 0x80ac58cd // ERC-721
            || id == 0x5b5e139f // ERC-721 Metadata
            || id == 0xb45a3c0e; // ERC-5192
    }

    // ---------------------------------------------------------------- 转移 / 授权：一律拒绝
    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    // ---------------------------------------------------------------- 元数据（链上生成）
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        string memory id = _toString(tokenId);
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480">',
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14181f"/><stop offset="1" stop-color="#0b0e11"/></linearGradient></defs>',
            '<rect width="480" height="480" rx="28" fill="url(#g)"/>',
            '<rect x="20" y="20" width="440" height="440" rx="20" fill="none" stroke="#f0b90b" stroke-opacity="0.55" stroke-width="2"/>',
            '<text x="240" y="150" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="30" letter-spacing="6" fill="#f0b90b">PIUPIU PASS</text>',
            '<text x="240" y="275" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="96" font-weight="700" fill="#ffffff">#',
            id,
            '</text>',
            '<text x="240" y="360" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="22" fill="#8b949e">Agent ID holder</text>',
            '<text x="240" y="400" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="16" fill="#6e7681">non-transferable</text>',
            "</svg>"
        );
        string memory json = string.concat(
            '{"name":"Piupiu Pass #',
            id,
            '","description":"A free, non-transferable on-chain pass for Agent ID holders. It carries no financial rights and promises no returns.",',
            '"attributes":[{"trait_type":"Requires","value":"Agent ID"},{"trait_type":"Transferable","value":"No"}],',
            '"image":"data:image/svg+xml;base64,',
            _base64(bytes(svg)),
            '"}'
        );
        return string.concat("data:application/json;base64,", _base64(bytes(json)));
    }

    // ---------------------------------------------------------------- 工具
    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v;
        uint256 len;
        while (n != 0) {
            len++;
            n /= 10;
        }
        bytes memory b = new bytes(len);
        while (v != 0) {
            b[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }

    bytes private constant _TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function _base64(bytes memory data) private pure returns (string memory) {
        uint256 len = data.length;
        if (len == 0) return "";
        bytes memory table = _TABLE;
        bytes memory out = new bytes(4 * ((len + 2) / 3));
        uint256 j;
        for (uint256 i; i < len; i += 3) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < len ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < len ? uint8(data[i + 2]) : 0;
            uint256 triple = (a << 16) | (b << 8) | c;
            out[j++] = table[(triple >> 18) & 63];
            out[j++] = table[(triple >> 12) & 63];
            out[j++] = i + 1 < len ? table[(triple >> 6) & 63] : bytes1("=");
            out[j++] = i + 2 < len ? table[triple & 63] : bytes1("=");
        }
        return string(out);
    }
}
