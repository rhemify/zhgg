/// OwnerMirror — resolve the iNFT's canonical owner from the Base-side
/// mirror so the Slice-Y AuditReport's `auditorAgent.owner` reflects
/// real cross-chain ownership rather than the deployer EOA.
///
/// Behaviour:
///   - `ownerMirrorAddress` undefined → fall back to `defaultOwner`
///     (typically the deployer). Mirrors the prior behaviour for runs
///     that don't have OWNER_MIRROR_ADDRESS wired in env.
///   - `ownerOf` returns the zero address (the mirror replies but the
///     tokenId hasn't been mirrored yet) → also fall back. The mirror
///     itself reverts in that case (`TokenIdNotMirrored`) and we surface
///     the revert verbatim, so this branch only fires for chains where
///     the mirror was upgraded to return 0x0 instead.
///   - `ownerOf` reverts → bubble the revert verbatim. The mirror's
///     `TokenIdNotMirrored(uint256)` reason is informative ("not
///     registered yet") and shouldn't be hidden behind a generic fall.

import { parseAbi, type Address, type PublicClient } from 'viem';

export const OWNER_MIRROR_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

export interface ResolveOwnerArgs {
  /// OwnerMirror contract address. Undefined → skip the read and return
  /// `defaultOwner` (the deployer EOA in current call sites).
  ownerMirrorAddress: Address | undefined;
  /// iNFT tokenId on 0G whose owner we want mirrored back on Base.
  tokenId: bigint;
  /// Base Sepolia public client. Type loosened so tests can pass a
  /// thin mock with just `readContract`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  basePub: Pick<PublicClient<any, any>, 'readContract'> | { readContract: (args: unknown) => Promise<unknown> };
  /// Fallback owner when the mirror isn't wired or returns 0x0. Almost
  /// always the deployer EOA.
  defaultOwner: Address;
}

export async function resolveOwner(args: ResolveOwnerArgs): Promise<Address> {
  if (!args.ownerMirrorAddress) return args.defaultOwner;
  const owner = (await args.basePub.readContract({
    address: args.ownerMirrorAddress,
    abi: OWNER_MIRROR_ABI,
    functionName: 'ownerOf',
    args: [args.tokenId],
  } as never)) as Address;
  if (owner === ZERO_ADDRESS) return args.defaultOwner;
  return owner;
}
