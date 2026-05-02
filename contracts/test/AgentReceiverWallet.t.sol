// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {AgentReceiverWallet} from "../src/AgentReceiverWallet.sol";
import {AgentReceiverWalletFactory} from "../src/AgentReceiverWalletFactory.sol";
import {IERC7857} from "../src/interfaces/IERC7857.sol";
import {IERC4626} from "../src/interfaces/IERC4626.sol";
import {MockERC4626} from "../src/mocks/MockERC4626.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
    function decimals() public pure override returns (uint8) { return 6; }
}

contract AgentReceiverWalletTest is Test {
    AgentNFT                   nft;
    FeeSplitter                splitter;
    AgentReceiverWalletFactory factory;
    MockUSDC                   usdc;

    address constant KH      = address(0xBEEF);
    address constant ZHGG    = address(0xCAFE);
    address constant COMMONS = address(0xDADA);
    address          agentOwner = makeAddr("agentOwner");
    address          stranger   = makeAddr("stranger");

    uint256 tokenId;

    function setUp() public {
        nft      = new AgentNFT();
        splitter = new FeeSplitter(KH, ZHGG, COMMONS);
        factory  = new AgentReceiverWalletFactory(address(nft), address(splitter));
        usdc     = new MockUSDC();

        tokenId = nft.mint(agentOwner, hex"");
    }

    // ----- CREATE2 determinism --------------------------------------

    function test_predictMatchesDeployedAddress() public {
        address predicted = factory.predict(tokenId);
        address deployed  = factory.deploy(tokenId);
        assertEq(predicted, deployed, "create2 mismatch");
    }

    function test_redeployReverts() public {
        factory.deploy(tokenId);
        vm.expectRevert();
        factory.deploy(tokenId);
    }

    function test_differentTokenIdsDifferentAddresses() public {
        uint256 t2 = nft.mint(agentOwner, hex"");
        assertTrue(factory.predict(tokenId) != factory.predict(t2));
    }

    // ----- splitMyBalance -------------------------------------------

    function test_anyoneCanSplit() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        usdc.mint(address(w), 100_000_000);

        vm.prank(stranger);
        w.splitMyBalance(IERC20(address(usdc)));

        assertEq(usdc.balanceOf(agentOwner), 85_000_000);
        assertEq(usdc.balanceOf(KH),          5_000_000);
        assertEq(usdc.balanceOf(ZHGG),        5_000_000);
        assertEq(usdc.balanceOf(COMMONS),     5_000_000);
        assertEq(usdc.balanceOf(address(w)),  0);
    }

    function test_splitWithZeroBalanceReverts() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        vm.expectRevert(
            abi.encodeWithSelector(AgentReceiverWallet.NothingToSplit.selector, address(usdc))
        );
        w.splitMyBalance(IERC20(address(usdc)));
    }

    function test_splitBelowThreshold_isNoOp() public {
        // Dust grief: an attacker airdrops less than MIN_SPLIT_AMOUNT to
        // the wallet. Splitter would revert with AmountBelowMinimum,
        // wedging the caller. The wallet must short-circuit so a bot
        // gets a clear BelowSplitThreshold signal instead of a vague
        // downstream revert.
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        usdc.mint(address(w), 9_999); // one below the 10_000 min

        vm.expectEmit(true, false, false, true);
        emit AgentReceiverWallet.BelowSplitThreshold(address(usdc), 9_999, 10_000);
        vm.prank(stranger);
        w.splitMyBalance(IERC20(address(usdc)));

        // Funds remain untouched; nothing was split.
        assertEq(usdc.balanceOf(address(w)), 9_999);
        assertEq(usdc.balanceOf(agentOwner), 0);
    }

    function test_splitAtExactThreshold_succeeds() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        usdc.mint(address(w), 10_000); // exactly the min
        vm.prank(stranger);
        w.splitMyBalance(IERC20(address(usdc)));

        assertEq(usdc.balanceOf(agentOwner), 8_500);
        assertEq(usdc.balanceOf(address(w)),     0);
    }

    function test_splitMyBalance_revertsAfterTokenBurn() public {
        // We don't have a public burn on AgentNFT, but a wallet can be
        // CREATE2-deployed for a token that was never minted — semantic
        // equivalent of a burn from the wallet's perspective. The
        // wallet's `splitMyBalance` MUST fail loudly via owner() rather
        // than sending USDC to address(0). This guards against the
        // catastrophic case where dust + a burned iNFT could otherwise
        // route the 85% leg to the zero address.
        uint256 unmintedId = 99_998;
        AgentReceiverWallet w =
            AgentReceiverWallet(payable(factory.deploy(unmintedId)));
        usdc.mint(address(w), 100_000_000); // above min so we exercise owner()

        vm.prank(stranger);
        vm.expectRevert();
        w.splitMyBalance(IERC20(address(usdc)));
    }

    function test_splitFollowsINFTOwnerOnTransfer() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        address newOwner = makeAddr("newOwner");

        // ERC-7857 self-transfer: from must equal msg.sender, proofs must
        // be non-empty (any commitment/signature passes in v1).
        IERC7857.TransferValidityProof[] memory proofs = new IERC7857.TransferValidityProof[](1);
        proofs[0] = IERC7857.TransferValidityProof({
            commitment: bytes32(uint256(1)),
            signature: hex"01"
        });
        vm.prank(agentOwner);
        nft.iTransferFrom(agentOwner, newOwner, tokenId, proofs);

        usdc.mint(address(w), 100_000_000);
        vm.prank(stranger);
        w.splitMyBalance(IERC20(address(usdc)));

        assertEq(usdc.balanceOf(newOwner),    85_000_000);
        assertEq(usdc.balanceOf(agentOwner),  0);
    }

    // ----- withdraw escape hatch ------------------------------------

    function test_withdrawByOwnerSucceeds() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        usdc.mint(address(w), 50_000_000);

        vm.prank(agentOwner);
        w.withdraw(IERC20(address(usdc)), agentOwner);
        assertEq(usdc.balanceOf(agentOwner), 50_000_000);
    }

    function test_withdrawByNonOwnerReverts() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        usdc.mint(address(w), 50_000_000);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(AgentReceiverWallet.NotOwner.selector, stranger, agentOwner)
        );
        w.withdraw(IERC20(address(usdc)), stranger);
    }

    // ----- ERC-1271 ---------------------------------------------------

    function test_erc1271_validOwnerSignature() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));

        // Re-mint to a known signer so we can vm.sign with their pk.
        uint256 pk = 0xA11CE;
        address signer = vm.addr(pk);
        IERC7857.TransferValidityProof[] memory proofs = new IERC7857.TransferValidityProof[](1);
        proofs[0] = IERC7857.TransferValidityProof({
            commitment: bytes32(uint256(1)),
            signature: hex"01"
        });
        vm.prank(agentOwner);
        nft.iTransferFrom(agentOwner, signer, tokenId, proofs);

        bytes32 hash = keccak256("kh-provision-challenge");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        bytes memory sig = abi.encodePacked(r, s, v);

        assertEq(w.isValidSignature(hash, sig), bytes4(0x1626ba7e));
    }

    function test_erc1271_wrongSignerFails() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        uint256 pk = 0xBADBAD;
        bytes32 hash = keccak256("kh-provision-challenge");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(w.isValidSignature(hash, sig), bytes4(0xffffffff));
    }

    /// SOL↔TS parity: GIVEN the same factory address, salt, and
    /// init-code hash, Solidity's `Create2.computeAddress` and viem's
    /// `getCreate2Address` must produce the same address. This locks
    /// the cross-language CREATE2 derivation independent of any
    /// specific contract bytecode — bytecode changes don't break this
    /// test. Same fixture asserted in
    /// `apps/mint-agent/test/receiver-wallet.test.ts`.
    function test_create2_address_derivation_parity() public pure {
        address factory = 0xfaC0101010101010101010101010101010101010;
        bytes32 salt = bytes32(uint256(42));
        bytes32 initCodeHash = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef;

        address solAddr = Create2.computeAddress(salt, initCodeHash, factory);
        address expected = 0x8946c09566121DC373d2C1640396296Ec11865Ef;
        assertEq(solAddr, expected, "SOL Create2 drift from TS fixture");
    }

    // ----- ERC-7710 delegation hooks -----

    function test_setDelegationManager_onlyOwner() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(AgentReceiverWallet.NotOwner.selector, stranger, agentOwner)
        );
        w.setDelegationManager(address(0xCAFE));
    }

    function test_setDelegationManager_lockMakesItPermanent() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        vm.prank(agentOwner);
        w.setDelegationManager(address(0xCAFE));
        assertEq(w.delegationManager(), address(0xCAFE));

        vm.prank(agentOwner);
        w.lockDelegationManager();
        assertTrue(w.delegationManagerLocked());

        // Subsequent set must fail.
        vm.prank(agentOwner);
        vm.expectRevert(AgentReceiverWallet.DelegationManagerAlreadyLocked.selector);
        w.setDelegationManager(address(0xBABE));
    }

    function test_lockDelegationManager_revertsIfManagerNotSet() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        vm.prank(agentOwner);
        vm.expectRevert(AgentReceiverWallet.DelegationManagerNotSet.selector);
        w.lockDelegationManager();
    }

    function test_executeViaDelegation_revertsForNonManager() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        vm.prank(agentOwner);
        w.setDelegationManager(address(0xCAFE));

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(AgentReceiverWallet.NotDelegationManager.selector, stranger)
        );
        w.executeViaDelegation(address(0xDEAD), 0, hex"");
    }

    function test_executeViaDelegation_authorizedCallerSucceeds() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        // Use this contract as the manager — calls executeViaDelegation directly.
        vm.prank(agentOwner);
        w.setDelegationManager(address(this));

        // Have the wallet call usdc.transfer(stranger, 50) — wallet sees itself as msg.sender.
        usdc.mint(address(w), 100);
        bytes memory data = abi.encodeCall(usdc.transfer, (stranger, 50));
        w.executeViaDelegation(address(usdc), 0, data);
        assertEq(usdc.balanceOf(stranger), 50);
        assertEq(usdc.balanceOf(address(w)), 50);
    }

    function test_erc1271_unmintedTokenReturnsFail() public {
        // Receiver wallets are CREATE2-addressable for any tokenId, so a
        // wallet can be deployed BEFORE its iNFT is minted (or after the
        // iNFT is burned). ERC-1271 contract-signature callers (Safe, AA
        // wallets) tolerate `0xffffffff` but break on reverts. Confirm
        // we return FAIL rather than reverting when `ownerOf` reverts.
        uint256 phantomTokenId = 99_999;
        AgentReceiverWallet w =
            AgentReceiverWallet(payable(factory.deploy(phantomTokenId)));

        uint256 pk = 0xA11CE;
        bytes32 hash = keccak256("kh-provision-challenge");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Must return FAIL, not revert.
        assertEq(w.isValidSignature(hash, sig), bytes4(0xffffffff));
    }

    // ----- ERC-4626 idle-USDC parking end-to-end demo -----------------
    //
    // Proves the full Tier-1 path: park idle USDC in a configured 4626
    // vault, simulate yield accrual, then partial-withdraw to capture
    // principal + share-of-yield. Backstops the demo claim that
    // AgentReceiverWallet's yield routing is wired (not just stubbed).

    function test_parkAndPartialWithdraw_capturesShareOfYield() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        MockERC4626 vault = new MockERC4626(IERC20(address(usdc)));

        // Wire the vault — must be the iNFT owner.
        vm.prank(agentOwner);
        w.setYieldVault(IERC4626(address(vault)));
        assertEq(address(w.yieldVault()), address(vault), "vault not wired");
        assertEq(w.yieldAsset(), address(usdc), "vault asset cache wrong");

        // Fund the wallet with 100 USDC and park half.
        usdc.mint(address(w), 100_000_000); // 100 USDC (6 decimals)
        // Sanity: parkIdle parks the FULL idle balance — the wallet can't
        // partial-park because parkIdle's purpose is yield-on-everything-
        // sitting-around. Move 50 USDC out of the wallet first so only
        // 50e6 is "idle" when we call parkIdle.
        vm.prank(agentOwner);
        w.withdraw(IERC20(address(usdc)), agentOwner); // sweep all 100e6 to owner
        usdc.mint(address(w), 50_000_000);             // re-fund with 50 USDC

        vm.prank(stranger); // permissionless — anyone may trigger parkIdle
        w.parkIdle();

        // Vault is empty before deposit, so 1:1 shares: 50e6 shares minted.
        assertEq(usdc.balanceOf(address(w)), 0, "wallet still holds raw USDC");
        assertEq(usdc.balanceOf(address(vault)), 50_000_000, "vault didn't receive USDC");
        assertApproxEqAbs(
            vault.balanceOf(address(w)),
            50_000_000,
            1, // tolerance: integer-rounding of 1:1 share math is exact, but be defensive
            "wallet share balance != ~50e6"
        );

        // Simulate 5 USDC of yield accruing inside the vault (e.g. an
        // Aave aToken's underlying interest). Direct mint-to-vault is the
        // cleanest way to push price-per-share above 1.0 in a test.
        usdc.mint(address(vault), 5_000_000);

        // At this point: vault holds 55 USDC, total shares = 50.
        //   pps = 55 / 50 = 1.1 USDC/share
        //   wallet's 50 shares are now worth 55 USDC.
        uint256 walletShareValue = vault.convertToAssets(vault.balanceOf(address(w)));
        assertEq(walletShareValue, 55_000_000, "share-of-yield math wrong");

        // Owner partial-withdraws their full pro-rata share (55 USDC).
        // Stranger cannot — withdrawIdle is owner-gated.
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(AgentReceiverWallet.NotOwner.selector, stranger, agentOwner)
        );
        w.withdrawIdle(walletShareValue);

        vm.prank(agentOwner);
        w.withdrawIdle(walletShareValue);

        // Wallet now holds principal + share-of-yield (50 + 5 = 55 USDC).
        // Constraint says ">= 50 + share-of-yield" — strict equality is
        // fine here because there are no other shareholders to dilute.
        assertGe(
            usdc.balanceOf(address(w)),
            50_000_000 + 5_000_000,
            "wallet didn't receive principal + share-of-yield"
        );
        assertEq(
            usdc.balanceOf(address(w)),
            55_000_000,
            "wallet received unexpected amount"
        );
        // All shares burned — wallet's vault balance is empty.
        assertEq(vault.balanceOf(address(w)), 0, "shares not fully burned");
    }

    function test_withdrawIdle_revertsForNonOwner() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        MockERC4626 vault = new MockERC4626(IERC20(address(usdc)));
        vm.prank(agentOwner);
        w.setYieldVault(IERC4626(address(vault)));

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(AgentReceiverWallet.NotOwner.selector, stranger, agentOwner)
        );
        w.withdrawIdle(1);
    }

    function test_withdrawIdle_isNoOpWhenNoVault() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        // No vault wired — owner call is a silent no-op (no revert, no
        // state change). Mirrors `withdrawAllIdle`'s contract.
        vm.prank(agentOwner);
        w.withdrawIdle(123);
        assertEq(usdc.balanceOf(address(w)), 0);
    }

    function test_withdrawIdle_zeroAmount_isNoOp() public {
        AgentReceiverWallet w = AgentReceiverWallet(payable(factory.deploy(tokenId)));
        MockERC4626 vault = new MockERC4626(IERC20(address(usdc)));
        vm.prank(agentOwner);
        w.setYieldVault(IERC4626(address(vault)));
        usdc.mint(address(w), 50_000_000);
        w.parkIdle();

        // Zero-asset withdraw must not call into the vault (which would
        // burn zero shares but still emit a redeem event). No-op keeps
        // gas + event noise minimal.
        uint256 sharesBefore = vault.balanceOf(address(w));
        vm.prank(agentOwner);
        w.withdrawIdle(0);
        assertEq(vault.balanceOf(address(w)), sharesBefore, "shares changed on zero-amount withdraw");
    }
}
