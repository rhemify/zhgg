# Demo Runbook

## Before you start — check your balances

Your wallet: `0x557E1E07652B75ABaA667223B11704165fC94d09`

You need:
- **Base Sepolia ETH** — for gas on every Base Sepolia tx. Get from https://www.alchemy.com/faucets/base-sepolia
- **Base Sepolia USDC** — for swap, park, acp create. Get from https://faucet.circle.com (select Base Sepolia)
- **0G OG** — for gas on 0G Galileo txs (audit, acp, axiom). Get from https://faucet.0g.ai
- **0G Compute Router credit** — for TEE inference during audit. Top up at https://pc.testnet.0g.ai (min 3 OG)

Check live balances any time by typing `balances` in the TUI.

---

## Start the TUI

```bash
bun run dev:tui
```

You'll see three panels: FLOW (left), AUDIT TRAIL (middle), ACTION QUEUE (right). Type intents at the bottom prompt and press Enter.

---

## Demo sequence

### 1. Orient
```
agents
```
Lists all minted iNFTs — name, token ID, wallet address. Agent #1 is the oracle agent.

```
balances
```
Shows your live 0G OG + Base Sepolia USDC. Confirms you're funded before doing anything.

---

### 2. The main event — compliance audit
```
audit 1
```
One command triggers the full cross-chain flow. Watch the AUDIT TRAIL panel fill up:
1. Reads agent capabilities from AgentNFT on 0G
2. Commits the audit plan hash on-chain (AxiomCommit — tamper-evident)
3. Pays the `eu-ai-act-audit` KeeperHub workflow via x402 USDC
4. Runs TEE inference on 0G Compute Router (Qwen model, EU AI Act scoring)
5. Posts the score on-chain via ERC-8004 giveFeedback
6. Reveals the AxiomCommit — plan + result now publicly verifiable

While it runs, open the AxiomCommit explorer link below to watch the commit land on 0G.

Try other topics — each is a separate on-chain audit:
```
audit 1 mica
```
```
audit 1 gdpr-ai
```
```
audit 1 price
```

---

### 3. Token swap
Make sure you have USDC or ETH on Base Sepolia first (`balances`).
```
swap 0.001 ETH to USDC
```
```
swap 5 USDC to WETH
```
Routes through Uniswap V3 on Base Sepolia. Watch the tx appear on Basescan (wallet link below).

---

### 4. Yield vault — park idle USDC
The receiver wallet needs USDC. If you just did a swap, some USDC is already there.
```
park 5 USDC
```
Deposits 5 USDC into the ERC-4626 vault on Base Sepolia. Starts accruing simulated yield.

```
unpark 5 USDC
```
Redeems it back.

---

### 5. KeeperHub marketplace
```
kh discover
```
Lists ~85 publicly available workflows with their slugs and prices.

```
kh hire eu-ai-act-audit {"agentName":"oracle"}
```
Pays and invokes the audit workflow directly via x402 — skips the audit orchestrator entirely. This is the inbound path: any KeeperHub user can hire zhgg agents.

---

### 6. Delegation — ERC-7710 spend cap
```
delegate 0x557E1E07652B75ABaA667223B11704165fC94d09 0x0000000000000000000000000000000000000000000000000000000000000000
```
Issues a spend-cap delegation to your own address on Base Sepolia. In production this authorises another agent to spend on your behalf up to a USDC cap.

---

## What to have open while demoing

| What | Link |
|---|---|
| Your wallet (Base Sepolia) | https://sepolia.basescan.org/address/0x557E1E07652B75ABaA667223B11704165fC94d09 |
| AgentNFT contract (0G) | https://chainscan-galileo.0g.ai/address/0x5298f4d8d8043c14e5f2683ad642febc8b54638f |
| AxiomCommit (0G) — watch commits land | https://chainscan-galileo.0g.ai/address/0xa471d2c45f03518e47c7fc71c897d244df01859d |
| FeeSplitter (Base Sepolia) — watch USDC splits | https://sepolia.basescan.org/address/0xb3a9ea5a72caab795bcf16c7bc5fd2d4863b47dd |
| Yield vault (Base Sepolia) | https://sepolia.basescan.org/address/0x0Ec3F1b4569692190585D5Bd9e947F5Bd4d31260 |
| DelegationManager (Base Sepolia) | https://sepolia.basescan.org/address/0xdee1f561d685cdced4c6caaa40f8c6f7112dffef |
| AA Factory (Base Sepolia) | https://sepolia.basescan.org/address/0x1eea5c29d671af30a2436078caf523919fd44304 |
| KeeperHub eu-ai-act-audit workflow | https://app.keeperhub.com/workflows/eu-ai-act-audit |
| KeeperHub marketplace | https://app.keeperhub.com/workflows |

## Faucets

| What | Link |
|---|---|
| Base Sepolia ETH | https://www.alchemy.com/faucets/base-sepolia |
| Base Sepolia USDC | https://faucet.circle.com |
| 0G OG testnet gas | https://faucet.0g.ai |
| 0G Compute Router credit | https://pc.testnet.0g.ai |
