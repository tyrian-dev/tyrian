// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "./PrincipalVault.sol";
import "../interfaces/IAggregatorV3.sol";

/**
 * @title StockVault
 * @notice Principal-protected vault for one allowlisted Robinhood Stock Token.
 *
 * Deploy one StockVault per ticker. There is no cross-ticker conversion.
 * The price feed is used for quota/indexer valuation only, never for swaps.
 */
contract StockVault is PrincipalVault {
    uint256 public constant MAX_STALE_LIMIT = 7 days;

    string public symbol;
    address public priceFeed;
    uint256 public depositCap;
    uint256 public maxStalePeriod = 96 hours;
    bool public stockEnabled = true;

    event StockRegistered(address indexed token, address indexed priceFeed, uint256 depositCap);
    event StockStatusUpdated(address indexed token, bool isAllowed);
    event DepositCapUpdated(uint256 oldCap, uint256 newCap);
    event PriceFeedUpdated(address indexed oldFeed, address indexed newFeed);
    event MaxStalePeriodUpdated(uint256 oldPeriod, uint256 newPeriod);
    event PriceInvalid(address indexed token, int256 answer, uint256 updatedAt);
    event PriceStale(address indexed token, uint256 updatedAt);

    error StockNotAllowed();
    error InvalidPrice();
    error StalePrice();
    error DepositCapExceeded();
    error InvalidCap();
    error InvalidStalePeriod();

    constructor(
        address asset_,
        string memory symbol_,
        address priceFeed_,
        uint256 depositCap_,
        address initialTreasury_,
        address initialOperator_,
        address initialOwner_
    ) PrincipalVault(asset_, initialTreasury_, initialOperator_, initialOwner_) {
        if (priceFeed_ == address(0) || depositCap_ == 0) revert InvalidAddress();
        symbol = symbol_;
        priceFeed = priceFeed_;
        depositCap = depositCap_;
        emit StockRegistered(asset_, priceFeed_, depositCap_);
    }

    function setStockEnabled(bool enabled) external onlyOwner {
        stockEnabled = enabled;
        emit StockStatusUpdated(address(assetToken), enabled);
    }

    function setDepositCap(uint256 newCap) external onlyOwner {
        if (newCap == 0) revert InvalidCap();
        emit DepositCapUpdated(depositCap, newCap);
        depositCap = newCap;
    }

    function setPriceFeed(address newFeed) external onlyOwner {
        if (newFeed == address(0)) revert InvalidAddress();
        emit PriceFeedUpdated(priceFeed, newFeed);
        priceFeed = newFeed;
    }

    function setMaxStalePeriod(uint256 newPeriod) external onlyOwner {
        if (newPeriod == 0 || newPeriod > MAX_STALE_LIMIT) revert InvalidStalePeriod();
        emit MaxStalePeriodUpdated(maxStalePeriod, newPeriod);
        maxStalePeriod = newPeriod;
    }

    /**
     * @notice Latest Chainlink price with the feed's native decimals.
     */
    function getLatestPrice(address token) public view returns (uint256 price, uint8 decimals) {
        if (token != address(assetToken)) revert StockNotAllowed();

        IAggregatorV3 feed = IAggregatorV3(priceFeed);
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();

        if (answer <= 0 || updatedAt == 0 || answeredInRound < roundId || updatedAt > block.timestamp) {
            revert InvalidPrice();
        }
        if (block.timestamp - updatedAt > maxStalePeriod) revert StalePrice();

        price = uint256(answer);
        decimals = feed.decimals();
    }

    /**
     * @notice USD value normalized to 18 decimals.
     */
    function getUsdValue(address token, uint256 amount) external view returns (uint256 valueUsd) {
        if (token != address(assetToken)) revert StockNotAllowed();
        (uint256 price, uint8 feedDecimals) = getLatestPrice(token);
        uint8 tokenDecimals = IERC20Metadata(address(assetToken)).decimals();
        valueUsd = (amount * price * 1e18) / (10 ** tokenDecimals * 10 ** feedDecimals);
    }

    function _beforeDeposit(address, uint256 amount) internal view override {
        if (!stockEnabled) revert StockNotAllowed();
        if (totalPrincipal + amount > depositCap) revert DepositCapExceeded();
    }
}
