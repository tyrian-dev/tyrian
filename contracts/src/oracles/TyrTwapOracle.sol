// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "../interfaces/IAggregatorV3.sol";
import "../interfaces/IUniswapV3Pool.sol";
import "../interfaces/ITyrTwapOracle.sol";
import "../libraries/TickMath.sol";

/**
 * @title TyrTwapOracle
 * @notice Provides on-chain 30-minute Uniswap V3 TWAP pricing for TYR.
 *
 * Rules:
 * - Reads historical cumulative ticks via `pool.observe([twapPeriod, 0])`.
 * - Rejects pools with insufficient observation cardinality.
 * - Never falls back to spot price (prevents flash loan price manipulation).
 * - Normalizes USD price to 18 decimals.
 * - Optional quote feed (e.g. WETH/USD) converts quote amounts to USD.
 */
contract TyrTwapOracle is ITyrTwapOracle, Ownable2Step {
    uint32 public constant MIN_TWAP_PERIOD = 300; // 5 minutes
    uint32 public constant MAX_TWAP_PERIOD = 86400; // 24 hours
    uint16 public constant ABSOLUTE_MIN_CARDINALITY = 2;
    uint256 public constant MAX_FEED_STALE_LIMIT = 7 days;
    uint8 public constant PRICE_DECIMALS = 18;

    address public immutable tyrToken;
    address public immutable quoteToken;
    address public immutable pool;
    uint8 public immutable tyrDecimals;
    uint8 public immutable quoteDecimals;
    bool public immutable tyrIsToken0;

    uint32 public twapPeriod = 1800; // 30 minutes
    uint16 public minCardinality = 10;
    address public quoteFeed;
    uint256 public maxFeedStalePeriod = 96 hours;

    event TwapPeriodUpdated(uint32 oldPeriod, uint32 newPeriod);
    event MinCardinalityUpdated(uint16 oldCardinality, uint16 newCardinality);
    event QuoteFeedUpdated(address indexed oldFeed, address indexed newFeed);
    event MaxFeedStalePeriodUpdated(uint256 oldPeriod, uint256 newPeriod);
    event TwapChecked(uint256 price18, int24 meanTick);
    event TwapInvalid(string reason);

    error InvalidAddress();
    error InvalidPeriod();
    error InvalidCardinality();
    error InvalidPoolTokens();
    error ZeroAmount();
    error InsufficientCardinality();
    error TwapObserveFailed();
    error InvalidQuoteFeedPrice();
    error StaleQuoteFeedPrice();

    constructor(
        address tyrToken_,
        address quoteToken_,
        address pool_,
        address quoteFeed_,
        address initialOwner
    ) Ownable(initialOwner) {
        if (tyrToken_ == address(0) || quoteToken_ == address(0) || pool_ == address(0)) {
            revert InvalidAddress();
        }

        address t0 = IUniswapV3Pool(pool_).token0();
        address t1 = IUniswapV3Pool(pool_).token1();

        if ((t0 == tyrToken_ && t1 == quoteToken_)) {
            tyrIsToken0 = true;
        } else if ((t0 == quoteToken_ && t1 == tyrToken_)) {
            tyrIsToken0 = false;
        } else {
            revert InvalidPoolTokens();
        }

        tyrToken = tyrToken_;
        quoteToken = quoteToken_;
        pool = pool_;
        quoteFeed = quoteFeed_;

        tyrDecimals = IERC20Metadata(tyrToken_).decimals();
        quoteDecimals = IERC20Metadata(quoteToken_).decimals();
    }

    /**
     * @notice Returns the quote token amount for `amountIn` of TYR based on the TWAP.
     * @param amountIn Amount of TYR to convert.
     * @return amountOutQuote Amount of quote token based on TWAP.
     */
    function consult(uint256 amountIn) public view returns (uint256 amountOutQuote) {
        if (amountIn == 0) revert ZeroAmount();

        (, , , uint16 cardinality, , , ) = IUniswapV3Pool(pool).slot0();
        if (cardinality < minCardinality) revert InsufficientCardinality();

        int24 meanTick = _getMeanTick();
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(meanTick);

        if (tyrIsToken0) {
            if (sqrtRatioX96 <= type(uint128).max) {
                uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
                amountOutQuote = Math.mulDiv(ratioX192, amountIn, 1 << 192);
            } else {
                uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
                amountOutQuote = Math.mulDiv(ratioX128, amountIn, 1 << 128);
            }
        } else {
            if (sqrtRatioX96 <= type(uint128).max) {
                uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
                amountOutQuote = Math.mulDiv(1 << 192, amountIn, ratioX192);
            } else {
                uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
                amountOutQuote = Math.mulDiv(1 << 128, amountIn, ratioX128);
            }
        }
    }

    /**
     * @notice Returns price of 1 TYR normalized to 18 decimals USD.
     */
    function getPrice() public view returns (uint256 price18) {
        uint256 oneTyr = 10 ** tyrDecimals;
        uint256 quoteAmount = consult(oneTyr);

        if (quoteFeed == address(0)) {
            // Quote token is assumed USD pegged (e.g. USDG or USDC)
            price18 = _scale(quoteAmount, quoteDecimals, PRICE_DECIMALS);
        } else {
            (uint256 feedPrice, uint8 feedDecimals) = _readQuoteFeed();
            uint256 quotePrice18 = _scale(feedPrice, feedDecimals, PRICE_DECIMALS);
            price18 = Math.mulDiv(quoteAmount, quotePrice18, 10 ** quoteDecimals);
        }
    }

    /**
     * @notice Returns USD value (18 decimals) of `amount` TYR tokens.
     */
    function getUsdValue(uint256 amount) external view returns (uint256 valueUsd18) {
        uint256 price18 = getPrice();
        valueUsd18 = Math.mulDiv(amount, price18, 10 ** tyrDecimals);
    }

    /**
     * @notice Keeper / monitoring hook. Never reverts on oracle failure.
     * @return ok True when the TWAP and feed are healthy and fresh.
     */
    function checkPrice() external returns (bool ok) {
        try IUniswapV3Pool(pool).slot0() returns (
            uint160, int24, uint16, uint16 cardinality, uint16, uint8, bool
        ) {
            if (cardinality < minCardinality) {
                emit TwapInvalid("InsufficientCardinality");
                return false;
            }
        } catch {
            emit TwapInvalid("Slot0Failed");
            return false;
        }

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapPeriod;
        secondsAgos[1] = 0;

        int24 meanTick;
        try IUniswapV3Pool(pool).observe(secondsAgos) returns (
            int56[] memory tickCumulatives, uint160[] memory
        ) {
            int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
            meanTick = int24(tickCumulativesDelta / int56(uint56(twapPeriod)));
            if (tickCumulativesDelta < 0 && (tickCumulativesDelta % int56(uint56(twapPeriod)) != 0)) {
                meanTick--;
            }
        } catch {
            emit TwapInvalid("ObserveFailed");
            return false;
        }

        if (quoteFeed != address(0)) {
            try IAggregatorV3(quoteFeed).latestRoundData() returns (
                uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80 answeredInRound
            ) {
                if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || answeredInRound < roundId) {
                    emit TwapInvalid("InvalidQuoteFeedPrice");
                    return false;
                }
                if (block.timestamp - updatedAt > maxFeedStalePeriod) {
                    emit TwapInvalid("StaleQuoteFeedPrice");
                    return false;
                }
            } catch {
                emit TwapInvalid("QuoteFeedCallFailed");
                return false;
            }
        }

        try this.getPrice() returns (uint256 price18) {
            emit TwapChecked(price18, meanTick);
            return true;
        } catch {
            emit TwapInvalid("GetPriceReverted");
            return false;
        }
    }

    // --- Admin Setters (Timelock / Owner) ---

    function setTwapPeriod(uint32 newPeriod) external onlyOwner {
        if (newPeriod < MIN_TWAP_PERIOD || newPeriod > MAX_TWAP_PERIOD) revert InvalidPeriod();
        emit TwapPeriodUpdated(twapPeriod, newPeriod);
        twapPeriod = newPeriod;
    }

    function setMinCardinality(uint16 newCardinality) external onlyOwner {
        if (newCardinality < ABSOLUTE_MIN_CARDINALITY) revert InvalidCardinality();
        emit MinCardinalityUpdated(minCardinality, newCardinality);
        minCardinality = newCardinality;
    }

    function setQuoteFeed(address newFeed) external onlyOwner {
        emit QuoteFeedUpdated(quoteFeed, newFeed);
        quoteFeed = newFeed;
    }

    function setMaxFeedStalePeriod(uint256 newPeriod) external onlyOwner {
        if (newPeriod == 0 || newPeriod > MAX_FEED_STALE_LIMIT) revert InvalidPeriod();
        emit MaxFeedStalePeriodUpdated(maxFeedStalePeriod, newPeriod);
        maxFeedStalePeriod = newPeriod;
    }

    // --- Internal Helpers ---

    function _getMeanTick() internal view returns (int24 meanTick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapPeriod;
        secondsAgos[1] = 0;

        try IUniswapV3Pool(pool).observe(secondsAgos) returns (
            int56[] memory tickCumulatives, uint160[] memory
        ) {
            int56 delta = tickCumulatives[1] - tickCumulatives[0];
            meanTick = int24(delta / int56(uint56(twapPeriod)));
            if (delta < 0 && (delta % int56(uint56(twapPeriod)) != 0)) {
                meanTick--;
            }
        } catch {
            revert TwapObserveFailed();
        }
    }

    function _readQuoteFeed() internal view returns (uint256 price, uint8 decimals) {
        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) =
            IAggregatorV3(quoteFeed).latestRoundData();

        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || answeredInRound < roundId) {
            revert InvalidQuoteFeedPrice();
        }
        if (block.timestamp - updatedAt > maxFeedStalePeriod) {
            revert StaleQuoteFeedPrice();
        }

        price = uint256(answer);
        decimals = IAggregatorV3(quoteFeed).decimals();
    }

    function _scale(uint256 value, uint8 fromDecimals, uint8 toDecimals) internal pure returns (uint256) {
        if (fromDecimals == toDecimals) return value;
        if (fromDecimals < toDecimals) {
            return value * (10 ** (toDecimals - fromDecimals));
        }
        return value / (10 ** (fromDecimals - toDecimals));
    }
}
