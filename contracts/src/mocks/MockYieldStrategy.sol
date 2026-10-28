// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IYieldStrategy.sol";

/**
 * @dev Test-only idle strategy. It never invents yield by itself; tests can mint
 * extra tokens to simulate positive yield or burn tokens to simulate a loss.
 */
contract MockYieldStrategy is IYieldStrategy {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable vault;

    constructor(address asset_, address vault_) {
        token = IERC20(asset_);
        vault = vault_;
    }

    function asset() external view returns (address) {
        return address(token);
    }

    function totalAssets() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function deposit(uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    function withdraw(uint256 amount) external returns (uint256 withdrawn) {
        withdrawn = amount;
        token.safeTransfer(vault, amount);
    }
}
