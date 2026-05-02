/// `bun mint-agent` — open onboarding CLI.
///
/// One command provisions a new agent: mints the iNFT, registers it in
/// AgentRegistry, mints the ENS subname, grants a SpendCap. Used live in
/// the demo to mint a third agent on stage from the audience.
///
/// Required env:
/// - MINT_AGENT_PRIVATE_KEY  — signer for all 4 calls
/// - AGENT_NFT_ADDRESS       — D1 contract on 0G Galileo
/// - AGENT_REGISTRY_ADDRESS  — D1 contract on 0G Galileo
/// - ENS_REGISTRAR_ADDRESS   — D1 contract on Sepolia (or mainnet)
/// - SPEND_CAP_ADDRESS       — D1 contract on Base Sepolia
/// - ZG_RPC_URL              — 0G Galileo RPC
/// - BASE_SEPOLIA_RPC_URL    — Base Sepolia RPC
/// - ENS_RPC_URL             — Sepolia or mainnet RPC for ENS

import {
  createPublicClient,
  createWalletClient,
  http,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  grantSpendCap,
  mintAgentNFT,
  mintSubname,
  registerAgent,
  type MintExecutor,
} from './steps.js';
import {
  PUBLIC_RESOLVER_MAINNET,
  PUBLIC_RESOLVER_SEPOLIA,
  setAgentTextRecords,
} from './ens-records.js';
import { deployReceiverWallet } from './receiver-wallet.js';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';

const USDC_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const DEFAULT_DAILY_CAP_USDC = 50_000_000n; // 50 USDC at 6 decimals
const DEFAULT_PERIOD_SECONDS = 86_400n; // 1 day

type AgentTier = 'oracle' | 'audit' | 'swap';

interface CliArgs {
  name: string;
  tier: AgentTier;
  owner: Address;
  ensMainnet: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let name: string | undefined;
  let tier: string | undefined;
  let owner: string | undefined;
  let ensMainnet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--name') name = argv[++i];
    else if (arg === '--tier') tier = argv[++i];
    else if (arg === '--owner') owner = argv[++i];
    else if (arg === '--ens-mainnet') ensMainnet = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!name) die('--name <slug> is required');
  if (!tier || (tier !== 'oracle' && tier !== 'audit' && tier !== 'swap')) {
    die('--tier must be one of: oracle, audit, swap');
  }
  if (!owner || !/^0x[a-fA-F0-9]{40}$/.test(owner)) {
    die('--owner must be a 0x-prefixed 20-byte address');
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    die('--name must be lowercase letters, digits, and hyphens only');
  }

  return { name, tier: tier as AgentTier, owner: owner as Address, ensMainnet };
}

function printHelp(): void {
  console.log(`bun mint-agent — open agent onboarding CLI

Usage:
  bun mint-agent --name <slug> --tier <oracle|audit|swap> --owner <0x...> [--ens-mainnet]

Required env:
  MINT_AGENT_PRIVATE_KEY  signer for all 4 calls
  AGENT_NFT_ADDRESS       0G Galileo
  AGENT_REGISTRY_ADDRESS  0G Galileo
  ENS_REGISTRAR_ADDRESS   Sepolia (or mainnet with --ens-mainnet)
  SPEND_CAP_ADDRESS       Base Sepolia
  ZG_RPC_URL              0G Galileo RPC
  BASE_SEPOLIA_RPC_URL    Base Sepolia RPC
  ENS_RPC_URL             Sepolia/mainnet RPC

Outputs: 4 tx hashes (iNFT mint, registry register, ENS subname, spend cap grant).
`);
}

function die(reason: string): never {
  console.error(`${ANSI_RED}error:${ANSI_RESET} ${reason}`);
  console.error(`run with --help for usage`);
  process.exit(1);
}

function reqEnv(key: string): string {
  const v = process.env[key];
  if (!v) die(`missing required env: ${key}`);
  return v;
}

interface ChainClients {
  wallet: ReturnType<typeof createWalletClient>;
  publicClient: ReturnType<typeof createPublicClient>;
}

function buildClients(rpcUrl: string, privateKey: Hex): ChainClients {
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);
  return {
    wallet: createWalletClient({ account, transport }),
    publicClient: createPublicClient({ transport }),
  };
}

function buildExecutor(clients: ChainClients): MintExecutor {
  const { wallet, publicClient } = clients;
  return {
    // chainId is part of the executor's MintExecutor type but the chain
    // is implicit in the transport binding here — each executor is built
    // per RPC URL, so passing chainId would be redundant. We accept and
    // ignore it for symmetry with mock executors used in tests.
    call: async ({ address, abi, functionName, args }) => {
      const sim = await publicClient.simulateContract({
        account: wallet.account,
        address,
        abi: abi as never,
        functionName: functionName as never,
        args: args as never,
      });
      const txHash = await wallet.writeContract(sim.request);
      // 0G Galileo's public RPC frequently lags the propagation of a
      // freshly-mined receipt — viem's default 6 retries × ~1s gives
      // up before the tx is queryable, even though the tx itself
      // landed. Bump the budget so a healthy mint doesn't surface as
      // a false "FAILED at step" and trigger the partial-state
      // recovery flow.
      await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 120_000,
        retryCount: 60,
      });
      return { result: sim.result as never, txHash };
    },
  };
}

function fmtHash(h: string | null | undefined): string {
  if (!h) return '—';
  if (h.length <= 12) return h;
  return `${h.slice(0, 8)}…${h.slice(-4)}`;
}

/// Per-tier capability descriptors baked into the iNFT manifest. The
/// off-chain router reads `capabilities[]` to decide which tools the
/// agent may invoke; `feeds[]` and `protocols[]` hint at the data
/// surface so the audit-agent can flag a request that exceeds the
/// declared envelope.
function buildCapabilityManifest(name: string, tier: AgentTier): Hex {
  const base = {
    type: `https://zhgg.eth/manifest/v1/${tier}`,
    name,
    tier,
  };
  let extra: Record<string, unknown>;
  switch (tier) {
    case 'oracle':
      extra = {
        capabilities: ['price_feed', 'regulatory_data', 'usdc_payment_receipt'],
        feeds: ['pyth', 'eu-ai-act'],
        settlement: { chain: 'eip155:84532', asset: 'usdc' },
      };
      break;
    case 'swap':
      extra = {
        capabilities: ['token_swap', 'spend_cap_aware'],
        protocols: ['uniswap-v3'],
        chains: ['eip155:84532'],
      };
      break;
    case 'audit':
    default:
      extra = {
        capabilities: ['compliance_probe', 'tee_attestation'],
        rulesets: ['eu-ai-act', 'mica'],
      };
      break;
  }
  return toHex(JSON.stringify({ ...base, ...extra }));
}

/// Successful step output is BUFFERED rather than printed eagerly. We
/// only flush once every step succeeds — otherwise a partial run shows
/// "✓ minted iNFT" in green and then "error" in red, leaving the user
/// uncertain whether the mint already landed on-chain. With buffering
/// the failure path prints a clear "PARTIAL ON-CHAIN" block listing
/// every tx that DID land so the user can inspect / clean up manually.
interface StepRecord {
  label: string;
  txHash: Hex;
  detail?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ruler = '━'.repeat(60);

  // ENS layer is opt-in: absence of ENS_REGISTRAR_ADDRESS skips both
  // subname mint (step 3) and text records (step 5) cleanly. Lets
  // hackathon teams ship the iNFT + 8004 + SpendCap + receiver wallet
  // bundle without owning a parent ENS name. Agent identity falls
  // back to (chainId, tokenId) — fully verifiable on chain.
  // Treat empty string the same as undefined — `source .env` exposes
  // unset values as `""` in process.env, which is "set but empty".
  const ensRegistrarRaw = process.env.ENS_REGISTRAR_ADDRESS;
  const ensRegistrar =
    ensRegistrarRaw && ensRegistrarRaw.length > 0
      ? (ensRegistrarRaw as Address)
      : undefined;
  const ensEnabled = ensRegistrar !== undefined;

  console.log(ruler);
  if (ensEnabled) {
    console.log(`  zhgg mint-agent — provisioning ${args.name}.zhgg.eth`);
  } else {
    console.log(`  zhgg mint-agent — provisioning iNFT for "${args.name}"`);
    console.log(`  ${ANSI_DIM}(ENS layer skipped — ENS_REGISTRAR_ADDRESS unset)${ANSI_RESET}`);
  }
  console.log(`  tier: ${args.tier}  owner: ${args.owner}`);
  if (ensEnabled) {
    console.log(`  ${ANSI_DIM}ENS network: ${args.ensMainnet ? 'mainnet' : 'sepolia'}${ANSI_RESET}`);
  }
  console.log(ruler);
  console.log('');

  const privateKey = reqEnv('MINT_AGENT_PRIVATE_KEY') as Hex;
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    die('MINT_AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
  }

  const agentNft = reqEnv('AGENT_NFT_ADDRESS') as Address;
  const agentRegistry = reqEnv('AGENT_REGISTRY_ADDRESS') as Address;
  const spendCap = reqEnv('SPEND_CAP_ADDRESS') as Address;
  const zgRpc = reqEnv('ZG_RPC_URL');
  const baseRpc = reqEnv('BASE_SEPOLIA_RPC_URL');

  const zgExecutor = buildExecutor(buildClients(zgRpc, privateKey));
  const baseExecutor = buildExecutor(buildClients(baseRpc, privateKey));

  // Only construct ENS clients when the layer is enabled — saves an
  // unnecessary RPC connection in the iNFT-only path.
  const ensClients = ensEnabled ? buildClients(reqEnv('ENS_RPC_URL'), privateKey) : null;
  const ensExecutor = ensClients ? buildExecutor(ensClients) : null;

  const manifest = buildCapabilityManifest(args.name, args.tier);
  const completed: StepRecord[] = [];

  function failPartial(failingStep: string, reason: string): never {
    console.error('');
    console.error(`${ANSI_RED}FAILED at step:${ANSI_RESET} ${failingStep}`);
    console.error(`  reason: ${reason}`);
    if (completed.length > 0) {
      console.error('');
      console.error(`${ANSI_RED}PARTIAL ON-CHAIN STATE (${completed.length}/4 steps committed):${ANSI_RESET}`);
      for (const rec of completed) {
        console.error(`  ${rec.label} ${ANSI_DIM}(tx ${fmtHash(rec.txHash)})${ANSI_RESET}`);
      }
      console.error('');
      console.error(`${ANSI_DIM}These transactions are mined and cannot be rolled back. Inspect each${ANSI_RESET}`);
      console.error(`${ANSI_DIM}tx hash on the relevant explorer; the orphaned iNFT/registry entry${ANSI_RESET}`);
      console.error(`${ANSI_DIM}can be transferred or burned manually if desired.${ANSI_RESET}`);
    }
    process.exit(1);
  }

  function ensureOk<T>(
    r: { ok: true; value: T } | { ok: false; error: { kind: string; reason: string } },
    step: string
  ): asserts r is { ok: true; value: T } {
    if (!r.ok) failPartial(step, r.error.reason);
  }

  // Step 1 — mint iNFT
  const minted = await mintAgentNFT(zgExecutor, {
    agentNft,
    owner: args.owner,
    capabilityManifest: manifest,
  });
  ensureOk(minted, 'mint iNFT (0G)');
  completed.push({
    label: `${ANSI_GREEN}✓${ANSI_RESET} minted iNFT #${minted.value.tokenId.toString()}`,
    txHash: minted.value.txHash,
  });

  // Step 2 — register in 8004
  // Custom `zhgg://` scheme makes it explicit that this is NOT a real
  // IPFS-pinned URI — D5 work pins the agent registration JSON to IPFS
  // and writes the real CID here. The `ens` metadata key is omitted
  // when ENS is disabled so off-chain indexers don't see a stale
  // `<name>.zhgg.eth` claim that doesn't resolve.
  const agentURI = `zhgg://placeholder/agent/${args.name}`;
  const metadata: Array<{ metadataKey: string; metadataValue: Hex }> = [
    { metadataKey: 'inft', metadataValue: toHex(`${agentNft}:${minted.value.tokenId}`) },
    { metadataKey: 'tier', metadataValue: toHex(args.tier) },
  ];
  if (ensEnabled) {
    metadata.splice(1, 0, {
      metadataKey: 'ens',
      metadataValue: toHex(`${args.name}.zhgg.eth`),
    });
  }
  const registered = await registerAgent(zgExecutor, {
    agentRegistry,
    agentURI,
    metadata,
  });
  ensureOk(registered, 'register agent (8004)');
  completed.push({
    label: `${ANSI_GREEN}✓${ANSI_RESET} registered agentId #${registered.value.agentId.toString()}`,
    txHash: registered.value.txHash,
  });

  // Step 3 — ENS subname (only when enabled). Step 4 — SpendCap
  // (always). When ENS is on, parallelize since they're on different
  // chains; otherwise run SpendCap standalone.
  const cappedPromise = grantSpendCap(baseExecutor, {
    spendCap,
    account: args.owner,
    asset: USDC_BASE_SEPOLIA,
    maxPerPeriod: DEFAULT_DAILY_CAP_USDC,
    periodLength: DEFAULT_PERIOD_SECONDS,
    expiresAt: 0n,
  });

  if (ensEnabled && ensExecutor) {
    const [subnameMinted, capped] = await Promise.all([
      mintSubname(ensExecutor, {
        ensRegistrar: ensRegistrar!,
        label: args.name,
        owner: args.owner,
        publicMint: true,
      }),
      cappedPromise,
    ]);

    ensureOk(subnameMinted, 'mint ENS subname');
    completed.push({
      label: `${ANSI_GREEN}✓${ANSI_RESET} minted ${args.name}.zhgg.eth`,
      txHash: subnameMinted.value.txHash,
    });

    ensureOk(capped, 'grant SpendCap (Base)');
    completed.push({
      label: `${ANSI_GREEN}✓${ANSI_RESET} spend cap 50 USDC/day`,
      txHash: capped.value.txHash,
    });

    // Step 5 — ENS text records (only when ENS is enabled and the
    // subname mint succeeded above). The resolver may need a pre-flight
    // `setResolver` tx; see ens-records.ts for that path.
    const resolver = args.ensMainnet ? PUBLIC_RESOLVER_MAINNET : PUBLIC_RESOLVER_SEPOLIA;
    try {
      const records = await setAgentTextRecords(ensClients!, {
        label: args.name,
        inft: `${agentNft}:${minted.value.tokenId.toString()}`,
        passport: `eip155:16602:${agentRegistry}:${registered.value.agentId.toString()}`,
        tier: args.tier,
        resolver,
      });
      for (const txHash of records.txHashes) {
        completed.push({
          label: `${ANSI_GREEN}✓${ANSI_RESET} ENS text records on ${args.name}.zhgg.eth`,
          txHash,
        });
      }
    } catch (e) {
      failPartial(
        'set ENS text records',
        e instanceof Error ? e.message : String(e)
      );
    }
  } else {
    // ENS skipped — just await the cap grant.
    const capped = await cappedPromise;
    ensureOk(capped, 'grant SpendCap (Base)');
    completed.push({
      label: `${ANSI_GREEN}✓${ANSI_RESET} spend cap 50 USDC/day`,
      txHash: capped.value.txHash,
    });
  }

  // Step 6 (optional) — deploy the per-iNFT receiver wallet so KH can
  // route the 70% leg of marketplace settlement through a public-trigger
  // smart wallet. Gated on RECEIVER_FACTORY_ADDRESS so partial-deploy
  // environments (no factory yet) skip cleanly.
  const receiverFactory = process.env.RECEIVER_FACTORY_ADDRESS as Address | undefined;
  if (receiverFactory) {
    try {
      // Receiver factory lives on Base Sepolia (the chain where USDC
      // settlement happens) — use the Base executor, not the 0G one.
      const deployed = await deployReceiverWallet(baseExecutor, {
        factory: receiverFactory,
        tokenId: minted.value.tokenId,
      });
      completed.push({
        label: `${ANSI_GREEN}✓${ANSI_RESET} receiver wallet at ${deployed.wallet}`,
        txHash: deployed.txHash,
      });
    } catch (e) {
      failPartial(
        'deploy receiver wallet',
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // All steps succeeded — flush buffered output now.
  for (const rec of completed) {
    console.log(`${rec.label} ${ANSI_DIM}(tx ${fmtHash(rec.txHash)})${ANSI_RESET}`);
  }
  console.log('');
  console.log(ruler);
  if (ensEnabled) {
    console.log(`  ${args.name}.zhgg.eth is live.`);
  } else {
    console.log(`  iNFT #${minted.value.tokenId.toString()} is live (agent: "${args.name}").`);
    console.log(`  ${ANSI_DIM}canonical id: eip155:16602:${agentNft}:${minted.value.tokenId.toString()}${ANSI_RESET}`);
  }
  console.log(ruler);
  process.exit(0);
}

// ─── Library entry point ────────────────────────────────────────────────
//
// Exposed so the TUI (and other in-process callers) can mint a fresh
// iNFT without shelling out to this CLI. Scope is intentionally narrow:
// just the AgentNFT.mint() call on 0G Galileo. The full provisioning
// pipeline (8004 register, ENS subname, SpendCap grant, receiver wallet)
// stays in `main()` because it spans three chains and isn't what the
// TUI's `mint <role>` operator command needs — that command is for
// expanding the audit/oracle/swap iNFT pool, not full onboarding.
//
// The TUI passes its own zg PublicClient + WalletClient (already built
// from the live bundle) so we don't re-instantiate transports per call.
// `account` is the WalletClient's signer; we accept it explicitly so
// the caller can validate it matches their MINT_AGENT_PRIVATE_KEY EOA
// before invoking us (the helper itself never sees the private key).

export type AgentRole = AgentTier;

export interface MintAgentInput {
  /// Tier — drives the capability manifest baked into the iNFT.
  role: AgentRole;
  /// Address that will own the freshly minted iNFT. Usually the same
  /// EOA backing `zgWalletClient` so the operator can later authorize
  /// usage / update memoryRoot from the TUI.
  account: Address;
  /// AgentNFT (ERC-7857) address on 0G Galileo — chain 16602.
  agentNftAddress: Address;
  /// 0G Galileo public client (chainId 16602). Used for simulateContract
  /// + waitForTransactionReceipt.
  zgPublicClient: PublicClient;
  /// 0G Galileo wallet client. The bound account here MUST equal the
  /// `account` field above (caller's responsibility).
  zgWalletClient: WalletClient;
}

export interface MintAgentResult {
  tokenId: bigint;
  txHash: Hex;
}

/// Library-mode mint. Single-purpose: mint one iNFT, return its
/// tokenId + tx hash. Throws on any RPC / revert error so the caller
/// can show the real chain message — no swallowing, no synthetic
/// fallback.
///
/// Slug for the manifest is auto-derived from role + an 8-char tail of
/// the freshly-minted block timestamp so two consecutive `mint audit`
/// calls don't produce byte-identical capability blobs.
export async function mintAgent(input: MintAgentInput): Promise<MintAgentResult> {
  const { role, account, agentNftAddress, zgPublicClient, zgWalletClient } = input;
  // Sanity check — caller-supplied wallet must hold an account.
  const walletAccount = zgWalletClient.account;
  if (!walletAccount) {
    throw new Error('zgWalletClient has no bound account — pass account: privateKeyToAccount(...) when creating it');
  }
  // The auto-generated name is just a manifest-internal slug; the
  // canonical id of the agent is (chainId, tokenId), not the slug.
  const slug = `${role}-${Date.now().toString(36)}`;
  const manifest = buildCapabilityManifest(slug, role);

  const executor: MintExecutor = {
    call: async ({ address, abi, functionName, args }) => {
      const sim = await zgPublicClient.simulateContract({
        account: walletAccount,
        address,
        abi: abi as never,
        functionName: functionName as never,
        args: args as never,
      });
      const txHash = await zgWalletClient.writeContract(sim.request);
      // Same generous wait budget used by the CLI buildExecutor — 0G
      // Galileo's public RPC frequently lags receipt propagation; viem's
      // default would surface a healthy mint as a "FAILED" timeout.
      await zgPublicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 120_000,
        retryCount: 60,
      });
      return { result: sim.result as never, txHash };
    },
  };

  const minted = await mintAgentNFT(executor, {
    agentNft: agentNftAddress,
    owner: account,
    capabilityManifest: manifest,
  });
  if (!minted.ok) {
    throw new Error(`mint failed: ${minted.error.reason}`);
  }
  return { tokenId: minted.value.tokenId, txHash: minted.value.txHash };
}

// CLI bootstrap — only runs when this file is invoked directly. Bun
// reports `process.argv[1]` as the entrypoint script, so guarding on
// that lets `import { mintAgent } from 'mint-agent'` work without
// triggering the CLI side-effects.
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`${ANSI_RED}mint-agent failed:${ANSI_RESET} ${reason}`);
    process.exit(1);
  });
}
