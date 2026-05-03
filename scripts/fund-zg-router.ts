/// One-shot funding script for the 0G Compute Router on Galileo testnet.
///
/// Bypasses the broken pc.testnet.0g.ai web UI by calling the Payment
/// Layer contract (`0x0AD9...9939`) directly via the official broker SDK.
/// Funds deposited here are debited by the same router that authenticates
/// our `sk-` API key — they share the on-chain account keyed by your
/// wallet address.
///
/// USAGE:
///   bun run scripts/fund-zg-router.ts                # deposits 0.05 0G
///   bun run scripts/fund-zg-router.ts 0.1            # deposits 0.1 0G
///   bun run scripts/fund-zg-router.ts --balance      # just shows balance
///
/// Requires MINT_AGENT_PRIVATE_KEY in .env (already set).

import 'dotenv/config';
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker';

const RPC_URL = 'https://evmrpc-testnet.0g.ai';

async function main(): Promise<void> {
  const pk = process.env.MINT_AGENT_PRIVATE_KEY;
  if (!pk) throw new Error('MINT_AGENT_PRIVATE_KEY missing from .env');

  const args = process.argv.slice(2);
  const balanceOnly = args.includes('--balance');
  const amountArg = args.find((a) => !a.startsWith('--'));
  const amount = amountArg ? Number(amountArg) : 0.05;

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(pk, provider);
  const address = await wallet.getAddress();

  const walletBalance = await provider.getBalance(address);
  console.log(`wallet:        ${address}`);
  console.log(`wallet 0G:     ${ethers.formatEther(walletBalance)} OG`);

  const broker = await createZGComputeNetworkBroker(wallet);

  let ledger;
  try {
    ledger = await broker.ledger.getLedger();
  } catch {
    ledger = null;
  }
  if (ledger) {
    console.log(`router locked: ${ethers.formatEther(ledger.totalBalance ?? 0n)} OG`);
    console.log(`router avail:  ${ethers.formatEther((ledger.totalBalance ?? 0n) - (ledger.locked ?? 0n))} OG`);
  } else {
    console.log('router ledger: <not yet initialised>');
  }

  if (balanceOnly) return;

  if (!ledger) {
    console.log(`creating ledger + depositing ${amount} OG ...`);
    await broker.ledger.addLedger(amount);
  } else {
    console.log(`depositing ${amount} OG ...`);
    await broker.ledger.depositFund(amount);
  }

  const after = await broker.ledger.getLedger();
  console.log(`router locked: ${ethers.formatEther(after.totalBalance ?? 0n)} OG`);
  console.log('done.');
}

main().catch((e: unknown) => {
  console.error('fund-zg-router failed:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
