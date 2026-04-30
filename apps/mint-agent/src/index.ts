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

interface CliArgs {
  name: string;
  tier: 'oracle' | 'audit';
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
  if (!tier || (tier !== 'oracle' && tier !== 'audit')) {
    die('--tier must be one of: oracle, audit');
  }
  if (!owner || !/^0x[a-fA-F0-9]{40}$/.test(owner)) {
    die('--owner must be a 0x-prefixed 20-byte address');
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    die('--name must be lowercase letters, digits, and hyphens only');
  }

  return { name, tier, owner: owner as Address, ensMainnet };
}

function printHelp(): void {
  console.log(`bun mint-agent — open agent onboarding CLI

Usage:
  bun mint-agent --name <slug> --tier <oracle|audit> --owner <0x...> [--ens-mainnet]

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
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      return { result: sim.result as never, txHash };
    },
  };
}

function fmtHash(h: string | null | undefined): string {
  if (!h) return '—';
  if (h.length <= 12) return h;
  return `${h.slice(0, 8)}…${h.slice(-4)}`;
}

function buildCapabilityManifest(name: string, tier: 'oracle' | 'audit'): Hex {
  const manifest = {
    type: `https://zhgg.eth/manifest/v1/${tier}`,
    name,
    tier,
  };
  return toHex(JSON.stringify(manifest));
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
  console.log(ruler);
  console.log(`  zhgg mint-agent — provisioning ${args.name}.zhgg.eth`);
  console.log(`  tier: ${args.tier}  owner: ${args.owner}`);
  console.log(`  ${ANSI_DIM}ENS network: ${args.ensMainnet ? 'mainnet' : 'sepolia'}${ANSI_RESET}`);
  console.log(ruler);
  console.log('');

  const privateKey = reqEnv('MINT_AGENT_PRIVATE_KEY') as Hex;
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    die('MINT_AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
  }

  const agentNft = reqEnv('AGENT_NFT_ADDRESS') as Address;
  const agentRegistry = reqEnv('AGENT_REGISTRY_ADDRESS') as Address;
  const ensRegistrar = reqEnv('ENS_REGISTRAR_ADDRESS') as Address;
  const spendCap = reqEnv('SPEND_CAP_ADDRESS') as Address;
  const zgRpc = reqEnv('ZG_RPC_URL');
  const baseRpc = reqEnv('BASE_SEPOLIA_RPC_URL');
  const ensRpc = reqEnv('ENS_RPC_URL');

  const zgExecutor = buildExecutor(buildClients(zgRpc, privateKey));
  const baseExecutor = buildExecutor(buildClients(baseRpc, privateKey));
  const ensClients = buildClients(ensRpc, privateKey);
  const ensExecutor = buildExecutor(ensClients);

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
  // and writes the real CID here.
  const agentURI = `zhgg://placeholder/agent/${args.name}`;
  const registered = await registerAgent(zgExecutor, {
    agentRegistry,
    agentURI,
    metadata: [
      { metadataKey: 'inft', metadataValue: toHex(`${agentNft}:${minted.value.tokenId}`) },
      { metadataKey: 'ens', metadataValue: toHex(`${args.name}.zhgg.eth`) },
      { metadataKey: 'tier', metadataValue: toHex(args.tier) },
    ],
  });
  ensureOk(registered, 'register agent (8004)');
  completed.push({
    label: `${ANSI_GREEN}✓${ANSI_RESET} registered agentId #${registered.value.agentId.toString()}`,
    txHash: registered.value.txHash,
  });

  // Steps 3 + 4 — ENS subname (Sepolia/mainnet) and SpendCap (Base Sepolia)
  // are independent and live on different chains. Parallelize to halve
  // the back-half wall-clock for the live stage demo.
  const [subnameMinted, capped] = await Promise.all([
    mintSubname(ensExecutor, {
      ensRegistrar,
      label: args.name,
      owner: args.owner,
      publicMint: true,
    }),
    grantSpendCap(baseExecutor, {
      spendCap,
      account: args.owner,
      asset: USDC_BASE_SEPOLIA,
      maxPerPeriod: DEFAULT_DAILY_CAP_USDC,
      periodLength: DEFAULT_PERIOD_SECONDS,
      expiresAt: 0n,
    }),
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

  // Step 5 — write ENS text records so external indexers can resolve
  // <name>.zhgg.eth → iNFT, ERC-8004 passport, tier. Done after the
  // subname is minted (step 3); not parallelizable with steps 3/4
  // because it needs the subname to exist + the resolver may need a
  // pre-flight setResolver tx (see ens-records.ts).
  const resolver = args.ensMainnet ? PUBLIC_RESOLVER_MAINNET : PUBLIC_RESOLVER_SEPOLIA;
  try {
    const records = await setAgentTextRecords(ensClients, {
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

  // Step 6 (optional) — deploy the per-iNFT receiver wallet so KH can
  // route the 70% leg of marketplace settlement through a public-trigger
  // smart wallet. Gated on RECEIVER_FACTORY_ADDRESS so partial-deploy
  // environments (no factory yet) skip cleanly.
  const receiverFactory = process.env.RECEIVER_FACTORY_ADDRESS as Address | undefined;
  if (receiverFactory) {
    try {
      const deployed = await deployReceiverWallet(zgExecutor, {
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
  console.log(`  ${args.name}.zhgg.eth is live.`);
  console.log(ruler);
  process.exit(0);
}

main().catch((err: unknown) => {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`${ANSI_RED}mint-agent failed:${ANSI_RESET} ${reason}`);
  process.exit(1);
});
