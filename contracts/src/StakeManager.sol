// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "./interfaces/IStakeVault.sol";

/**
 * @title StakeManager
 * @notice Accounting and cooldown layer for Tyrian staking.
 *
 * Custody lives in an IStakeVault. This contract only tracks shares, epochs,
 * and unstake requests. It never holds user tokens after a successful stake.
 *
 * Rules:
 * - New stakes become active in the next epoch.
 * - An unstake request stops quota immediately and creates an independent
 *   cooldown request with its own unlock timestamp.
 * - Pause blocks new stakes only; requestUnstake and withdraw stay available.
 * - No admin function can move a user's shares or assets.
 */
contract StakeManager is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant EPOCH_DURATION = 1 days;
    uint256 public cooldownDuration = 7 days;

    enum AssetKind {
        BASE,
        STOCK,
        BOOST
    }

    struct AssetConfig {
        bool enabled;
        AssetKind kind;
        address vault;
        address priceFeed;
        uint256 depositCap;
        uint256 totalShares;
    }

    struct Position {
        uint256 activeShares;
        uint256 pendingShares;
        uint256 pendingEpoch;
        uint256 cooldownShares;
        uint256 earliestUnlockAt;
    }

    struct UnstakeRequest {
        uint256 shares;
        uint256 unlockAt;
        bool claimed;
    }

    mapping(address => AssetConfig) public assetConfig;
    mapping(address => mapping(address => Position)) public positions;
    mapping(address => mapping(address => mapping(uint256 => UnstakeRequest))) public unstakeRequests;

    mapping(address => mapping(address => uint256)) public nextRequestId;

    mapping(address => bool) private _knownAsset;
    address[] public assetList;

    address public guardian;

    event AssetConfigUpdated(address indexed asset, bool enabled, address vault, address priceFeed, uint256 depositCap);
    event Staked(address indexed user, address indexed asset, uint256 amount, uint256 shares, uint256 effectiveEpoch);
    event UnstakeRequested(
        address indexed user, address indexed asset, uint256 requestId, uint256 shares, uint256 unlockAt
    );
    event Withdrawn(address indexed user, address indexed asset, uint256 requestId, uint256 shares, uint256 amount);
    event CooldownDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event GuardianUpdated(address indexed oldGuardian, address indexed newGuardian);

    error AssetNotEnabled();
    error AssetNotConfigured();
    error ZeroAmount();
    error ZeroShares();
    error NotGuardian();
    error InvalidVault();
    error VaultAssetMismatch();
    error VaultAlreadyInUse();
    error VaultNotEmpty();
    error DepositCapExceeded();
    error InsufficientActiveStake();
    error CooldownNotElapsed();
    error NoUnstakeRequest();
    error RequestAlreadyClaimed();
    error FeeOnTransferNotSupported();

    constructor(address initialOwner) Ownable(initialOwner) {
        guardian = initialOwner;
    }

    modifier onlyGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) revert NotGuardian();
        _;
    }

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH_DURATION;
    }

    function assetListLength() external view returns (uint256) {
        return assetList.length;
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert InvalidVault();
        emit GuardianUpdated(guardian, newGuardian);
        guardian = newGuardian;
    }

    function setCooldownDuration(uint256 newDuration) external onlyOwner {
        emit CooldownDurationUpdated(cooldownDuration, newDuration);
        cooldownDuration = newDuration;
    }

    /**
     * @notice Configure one asset. A vault can only be attached to one asset and
     * cannot be replaced while shares are outstanding.
     */
    function setAssetConfig(
        address asset,
        bool enabled,
        AssetKind kind,
        address vault,
        address priceFeed,
        uint256 depositCap
    ) external onlyOwner {
        if (asset == address(0)) revert AssetNotConfigured();

        AssetConfig storage cfg = assetConfig[asset];
        if (enabled && vault == address(0)) revert InvalidVault();
        if (vault != address(0)) {
            if (IStakeVault(vault).asset() != asset) revert VaultAssetMismatch();
            // Never migrate outstanding shares to a different vault. Disabling
            // with vault=0 keeps the existing vault so withdraw still works.
            if (cfg.totalShares != 0 && cfg.vault != vault) revert VaultAlreadyInUse();
            // Assets can remain in a vault even after every share was redeemed
            // (dust, donations, or a strategy loss). Replacing such a vault
            // would strand those assets and let the new vault start from a
            // mismatched accounting base.
            if (cfg.vault != address(0) && cfg.vault != vault && IStakeVault(cfg.vault).totalAssets() != 0) {
                revert VaultNotEmpty();
            }
        } else {
            vault = cfg.vault;
        }

        if (!_knownAsset[asset]) {
            _knownAsset[asset] = true;
            assetList.push(asset);
        }

        cfg.enabled = enabled;
        cfg.kind = kind;
        cfg.vault = vault;
        cfg.priceFeed = priceFeed;
        cfg.depositCap = depositCap;

        emit AssetConfigUpdated(asset, enabled, vault, priceFeed, depositCap);
    }

    function pause() external onlyGuardian {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Effective position including a pending epoch rollover.
     */
    function getEffectivePosition(address user, address asset)
        public
        view
        returns (uint256 effectiveActiveShares, uint256 pendingShares, uint256 cooldownShares, uint256 earliestUnlockAt)
    {
        Position storage pos = positions[user][asset];
        uint256 currEpoch = currentEpoch();

        if (pos.pendingShares > 0 && currEpoch > pos.pendingEpoch) {
            effectiveActiveShares = pos.activeShares + pos.pendingShares;
            pendingShares = 0;
        } else {
            effectiveActiveShares = pos.activeShares;
            pendingShares = pos.pendingShares;
        }

        cooldownShares = pos.cooldownShares;
        earliestUnlockAt = pos.earliestUnlockAt;
    }

    function getUnstakeRequest(address user, address asset, uint256 requestId)
        external
        view
        returns (UnstakeRequest memory)
    {
        return unstakeRequests[user][asset][requestId];
    }

    /**
     * @notice Deposit into the asset vault. Shares become active next epoch.
     */
    function stake(address asset, uint256 amount) external nonReentrant whenNotPaused {
        AssetConfig storage cfg = assetConfig[asset];
        if (!cfg.enabled || cfg.vault == address(0)) revert AssetNotEnabled();
        if (amount == 0) revert ZeroAmount();

        uint256 principalBefore = IStakeVault(cfg.vault).totalPrincipal();
        if (cfg.depositCap != 0 && principalBefore + amount > cfg.depositCap) {
            revert DepositCapExceeded();
        }

        Position storage pos = positions[msg.sender][asset];
        _rollPending(pos);

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert FeeOnTransferNotSupported();

        IERC20(asset).forceApprove(cfg.vault, amount);
        uint256 shares = IStakeVault(cfg.vault).depositFor(msg.sender, amount);
        IERC20(asset).forceApprove(cfg.vault, 0);

        if (shares == 0) revert ZeroShares();

        pos.pendingShares += shares;
        pos.pendingEpoch = currentEpoch();
        cfg.totalShares += shares;

        emit Staked(msg.sender, asset, amount, shares, pos.pendingEpoch + 1);
    }

    /**
     * @notice Start an independent cooldown request. Quota stops immediately.
     */
    function requestUnstake(address asset, uint256 amount) external nonReentrant returns (uint256 requestId) {
        AssetConfig storage cfg = assetConfig[asset];
        if (cfg.vault == address(0)) revert AssetNotConfigured();
        if (amount == 0) revert ZeroAmount();

        Position storage pos = positions[msg.sender][asset];
        _rollPending(pos);

        IStakeVault vault = IStakeVault(cfg.vault);
        uint256 activeValue = vault.previewRedeem(pos.activeShares);
        if (amount > activeValue) revert InsufficientActiveStake();

        uint256 shares = amount == activeValue ? pos.activeShares : vault.previewDeposit(amount);
        if (shares == 0) revert ZeroShares();
        if (shares > pos.activeShares) shares = pos.activeShares;

        pos.activeShares -= shares;
        pos.cooldownShares += shares;

        requestId = nextRequestId[msg.sender][asset] + 1;
        nextRequestId[msg.sender][asset] = requestId;
        uint256 unlockAt = block.timestamp + cooldownDuration;
        unstakeRequests[msg.sender][asset][requestId] =
            UnstakeRequest({shares: shares, unlockAt: unlockAt, claimed: false});

        if (pos.earliestUnlockAt == 0 || unlockAt < pos.earliestUnlockAt) {
            pos.earliestUnlockAt = unlockAt;
        }

        emit UnstakeRequested(msg.sender, asset, requestId, shares, unlockAt);
    }

    /**
     * @notice Withdraw one matured request. Never blocked by pause.
     */
    function withdraw(address asset, uint256 requestId) external nonReentrant returns (uint256 amount) {
        amount = _withdraw(msg.sender, asset, requestId);
    }

    /**
     * @notice Withdraw up to maxRequests matured requests in one transaction.
     */
    function withdrawMatured(address asset, uint256 maxRequests) external nonReentrant returns (uint256 totalAmount) {
        if (maxRequests == 0) revert ZeroAmount();

        uint256 last = nextRequestId[msg.sender][asset];
        uint256 processed = 0;
        for (uint256 id = 1; id <= last && processed < maxRequests; id++) {
            UnstakeRequest storage req = unstakeRequests[msg.sender][asset][id];
            if (req.shares == 0 || req.claimed || block.timestamp < req.unlockAt) continue;
            totalAmount += _withdraw(msg.sender, asset, id);
            processed++;
        }
    }

    function _withdraw(address user, address asset, uint256 requestId) internal returns (uint256 amount) {
        AssetConfig storage cfg = assetConfig[asset];
        if (cfg.vault == address(0)) revert AssetNotConfigured();

        UnstakeRequest storage req = unstakeRequests[user][asset][requestId];
        if (req.shares == 0) revert NoUnstakeRequest();
        if (req.claimed) revert RequestAlreadyClaimed();
        if (block.timestamp < req.unlockAt) revert CooldownNotElapsed();

        Position storage pos = positions[user][asset];

        req.claimed = true;
        pos.cooldownShares -= req.shares;
        cfg.totalShares -= req.shares;

        if (pos.earliestUnlockAt == req.unlockAt) {
            pos.earliestUnlockAt = _findEarliestUnlock(user, asset);
        }

        amount = IStakeVault(cfg.vault).redeemFor(user, req.shares);

        emit Withdrawn(user, asset, requestId, req.shares, amount);
    }

    function _rollPending(Position storage pos) internal {
        uint256 currEpoch = currentEpoch();
        if (pos.pendingShares > 0 && currEpoch > pos.pendingEpoch) {
            pos.activeShares += pos.pendingShares;
            pos.pendingShares = 0;
        }
    }

    function _findEarliestUnlock(address user, address asset) internal view returns (uint256 earliest) {
        uint256 last = nextRequestId[user][asset];
        for (uint256 id = 1; id <= last; id++) {
            UnstakeRequest storage req = unstakeRequests[user][asset][id];
            if (req.shares == 0 || req.claimed) continue;
            if (earliest == 0 || req.unlockAt < earliest) earliest = req.unlockAt;
        }
    }
}
