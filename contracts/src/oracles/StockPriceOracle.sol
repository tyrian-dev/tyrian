// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "../interfaces/IAggregatorV3.sol";
import "../interfaces/IStockPriceOracle.sol";

/**
 * @title StockPriceOracle
 * @notice Normalizes one Chainlink stock feed to 18 decimals.
 *
 * Deploy one oracle per ticker so a misconfigured feed can only affect that
 * ticker. The vault, portfolio, and indexer read the same normalized price.
 *
 * Rules:
 * - Reject `answer <= 0`, `updatedAt == 0`, a future `updatedAt`, and
 *   `answeredInRound < roundId` (incomplete round).
 * - Reject a round older than `maxStalePeriod` (default 96 hours, capped at 7
 *   days).
 * - Normalize to 18 decimals so callers never multiply raw feed decimals.
 *
 * The view getters must revert on bad data so callers fail closed. Because a
 * view function cannot emit an event, `checkPrice()` is the observability hook
 * for keepers/monitoring: it returns `false` and emits `PriceInvalid` or
 * `PriceStale` instead of reverting.
 */
contract StockPriceOracle is IStockPriceOracle, Ownable2Step {
    uint256 public constant MAX_STALE_LIMIT = 7 days;
    uint8 public constant PRICE_DECIMALS = 18;

    address public immutable stockToken;
    uint8 public immutable stockDecimals;

    address public feed;
    uint256 public maxStalePeriod = 96 hours;

    event FeedUpdated(address indexed oldFeed, address indexed newFeed);
    event MaxStalePeriodUpdated(uint256 oldPeriod, uint256 newPeriod);
    event PriceInvalid(address indexed token, int256 answer, uint256 updatedAt);
    event PriceStale(address indexed token, uint256 updatedAt);

    error InvalidAddress();
    error InvalidStalePeriod();
    error InvalidPrice();
    error StalePrice();
    error StockNotAllowed();

    constructor(address stockToken_, address feed_, address initialOwner) Ownable(initialOwner) {
        if (stockToken_ == address(0) || feed_ == address(0)) revert InvalidAddress();

        stockToken = stockToken_;
        stockDecimals = IERC20Metadata(stockToken_).decimals();
        feed = feed_;
    }

    /**
     * @notice Latest price normalized to 18 decimals.
     */
    function getPrice() public view returns (uint256 price18) {
        (uint256 price, uint8 feedDecimals) = _readPrice();
        price18 = _scale(price, feedDecimals, PRICE_DECIMALS);
    }

    /**
     * @notice USD value of `amount` stock tokens, normalized to 18 decimals.
     */
    function getUsdValue(address token, uint256 amount) external view returns (uint256 valueUsd18) {
        if (token != stockToken) revert StockNotAllowed();

        uint256 price18 = getPrice();
        valueUsd18 = Math.mulDiv(amount, price18, 10 ** stockDecimals);
    }

    /**
     * @notice Keeper/monitoring hook. Never reverts on bad feed data.
     * @return ok True when the feed is valid and fresh.
     */
    function checkPrice() external returns (bool ok) {
        try IAggregatorV3(feed).latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || answeredInRound < roundId) {
                emit PriceInvalid(stockToken, answer, updatedAt);
                return false;
            }
            if (block.timestamp - updatedAt > maxStalePeriod) {
                emit PriceStale(stockToken, updatedAt);
                return false;
            }
            return true;
        } catch {
            emit PriceInvalid(stockToken, 0, 0);
            return false;
        }
    }

    function setFeed(address newFeed) external onlyOwner {
        if (newFeed == address(0)) revert InvalidAddress();
        emit FeedUpdated(feed, newFeed);
        feed = newFeed;
    }

    function setMaxStalePeriod(uint256 newPeriod) external onlyOwner {
        if (newPeriod == 0 || newPeriod > MAX_STALE_LIMIT) revert InvalidStalePeriod();
        emit MaxStalePeriodUpdated(maxStalePeriod, newPeriod);
        maxStalePeriod = newPeriod;
    }

    function _readPrice() private view returns (uint256 price, uint8 feedDecimals) {
        IAggregatorV3 aggregator = IAggregatorV3(feed);
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = aggregator.latestRoundData();

        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || answeredInRound < roundId) {
            revert InvalidPrice();
        }
        if (block.timestamp - updatedAt > maxStalePeriod) revert StalePrice();

        feedDecimals = aggregator.decimals();
        // A feed above 36 decimals cannot be normalized safely.
        if (feedDecimals > 36) revert InvalidPrice();

        price = uint256(answer);
    }

    function _scale(uint256 value, uint8 from, uint8 to) private pure returns (uint256) {
        if (from == to) return value;
        if (from < to) return value * 10 ** (to - from);
        return value / 10 ** (from - to);
    }
}
