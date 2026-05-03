# Canonical AuditReport Schema

> Last verified: 2026-05-03 against branch `siewwin`.

The tamper-proof JSON evidence chain `audit.zhgg.eth` writes after every
audit. Designed so an EU AI Act regulator can fetch the bytes from 0G
Storage, recompute the hash, and prove the auditor agreed to those
exact bytes on-chain via ERC-8004 `giveFeedback`.

Source of truth: `packages/workflow/src/audit-report.ts` (Slice Y,
commit `b4f0350`; reviewer fixes `f60af3d`, `23be14c`).

## Three-stage write

| Stage | Function | I/O | What it does |
|---|---|---|---|
| 1. Build | `buildAuditReport(input)` | pure | Validates required fields; throws `AuditReportError(missing_field|invalid_hex)` with the field path. Hex slots are checked against `^0x[0-9a-fA-F]+$` (reviewer fix #2). |
| 2. Canonicalize | `canonicalizeAuditReport(report)` | pure | Recursive key-sorted JSON, no whitespace. `anchors.feedbackTx` dropped, `anchors.feedbackHash` zeroed before hashing (self-referential fixed point). `bigint` values rejected with `invalid_hex` kind + named field path (reviewer fix #3). Returns `{ bytes: Uint8Array, hash: Hex }`. |
| 3. Write | `writeAuditReport(report, opts)` | async, may fail | Pins canonical bytes to 0G Storage via injected `Storage0GClient`. **Refuses** with `storage_disabled` (when `ZG_STORAGE_ENABLED !== '1'`) or `no_client` (when no client supplied) — never fabricates a fake URI. |

## Type shape (verbatim from `packages/workflow/src/audit-report.ts:42`)

```typescript
interface AuditReport {
  version: '1.0';
  auditorAgent: {
    iNFTAddress: Address;
    tokenId: string;        // bigint encoded as decimal string
    ens: string;
    manifestHash: Hex;      // keccak of capabilities() bytes
    owner: Address;
  };
  subjectAgent: {
    tokenId: string;
    ens?: string;
    capabilitiesAtAudit: Hex;
    registeredAtBlock: string;
  };
  regulation: {
    framework: string;      // e.g. 'EU AI Act Regulation 2024/1689'
    articlesProbed: string[];
    regulatorySource?: { type: string; publishedAt?: string; fetchedFromCID?: string };
  };
  evidenceChain: {
    axiomCommit?: { commitId: Hex; commitTx: Hex; commitBlock: string };
    qwenInference?: {
      modelId: string;
      providerAddress?: Address;
      promptHash: Hex;
      responseHash: Hex;
      teeAttestation?: Hex;  // null when ZG_ROUTER_KEY unfunded → synthetic
      verifiedAtBlock?: string;
    };
    settlement?: {
      rail: 'x402' | 'direct_split';
      tx: Hex;
      amount: string;        // atomic units, e.g. "100000" for 0.1 USDC
      splitBPS?: number[];
    };
    axiomReveal?: { commitId: Hex; revealTx: Hex; revealBlock: string };
  };
  verdict: {
    compliant: boolean;
    findings: AuditReportFinding[];
    confidence: number;      // 0..1
    valueSigned: number;     // ERC-8004 value, -100..+100
    valueDecimals: number;   // ERC-8004 valueDecimals (2 → percent-points)
  };
  anchors: {
    feedbackTx?: Hex;        // STAMPED AFTER giveFeedback returns; excluded from canonicalization
    feedbackHash: Hex;       // keccak256 of canonical bytes with feedbackHash=0x0..0
    storageURI: string;      // 0G Storage rootHash; "" = "evidence not pinned"
  };
  auditorSignature?: Hex;    // Stretch goal; currently unused
}

interface AuditReportFinding {
  article: string;
  status: 'pass' | 'fail' | 'inconclusive';
  evidence: string;
  qwenReasoning?: Hex;
}
```

## Sample (audit run from MCP route, no orchestrator legs)

This is what `apps/zhgg-mcp-adapter/src/index.ts:189-267` produces for a
non-compliant verdict on subject token `42`:

```json
{
  "anchors": {
    "feedbackHash": "0x9f3a7c1e2b8d4f6a5c0b9e7d4a8c2f1b3e6d5a4c8b7f9e1d2a3c4b5f6e7d8a9b",
    "storageURI": ""
  },
  "auditorAgent": {
    "ens": "audit.zhgg.eth",
    "iNFTAddress": "0xAgentRegistry000000000000000000000000fEEd",
    "manifestHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "owner": "0xAuditorEoa00000000000000000000000000Beef",
    "tokenId": "1"
  },
  "evidenceChain": {
    "qwenInference": {
      "modelId": "qwen-2.5-7b-instruct",
      "promptHash": "0x4a2b...",
      "responseHash": "0x7c8d...",
      "teeAttestation": "0x12ab..."
    }
  },
  "regulation": {
    "articlesProbed": ["Article 13 — Transparency", "Article 14 — Human Oversight"],
    "framework": "EU AI Act Regulation 2024/1689"
  },
  "subjectAgent": {
    "capabilitiesAtAudit": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "ens": "subject.zhgg.eth",
    "registeredAtBlock": "0",
    "tokenId": "42"
  },
  "verdict": {
    "compliant": false,
    "confidence": 0.95,
    "findings": [
      { "article": "Article 13 — Transparency", "evidence": "Agent did not disclose model identity on probe", "status": "fail" },
      { "article": "Article 14 — Human Oversight", "evidence": "No human-override path documented", "status": "fail" }
    ],
    "valueDecimals": 0,
    "valueSigned": 0
  },
  "version": "1.0"
}
```

Note: keys are sorted alphabetically (canonical output). Real
`feedbackHash` would be the keccak of these exact bytes with `feedbackHash`
itself zeroed — that's the self-referential fixed point.

## Canonical hash recipe

```
input  = AuditReport with anchors.feedbackTx removed, anchors.feedbackHash = 0x0…0 (32 bytes zero)
bytes  = canonicalJsonStringify(input)            // recursive key-sorted, no whitespace, undefined→absent
        |> new TextEncoder().encode               // UTF-8
hash   = keccak256(bytes)                          // viem keccak256
```

Implementation: `canonicalJsonStringify` (`audit-report.ts:195`) +
`canonicalizeAuditReport` (`audit-report.ts:230`).

Determinism guarantees:
- Object keys sorted lexicographically at every nesting level.
- Arrays preserve insertion order (only object keys sort).
- `undefined` properties dropped (matches `JSON.stringify`).
- `bigint` values throw `AuditReportError(invalid_hex, <field-path>)` with the
  exact path so the operator fixes the caller, not chases a stack trace.
- `feedbackTx` field omitted from canonical bytes (canonicalize zeroes it
  before hashing) — hash is stable BEFORE the on-chain tx hash exists.

## On-chain anchor (ERC-8004)

After `writeAuditReport` returns, the orchestrator calls
`AgentRegistry.giveFeedback(...)` (see
`apps/zhgg-mcp-adapter/src/index.ts:130-152`):

```solidity
function giveFeedback(
    uint256 agentId,         // subject iNFT id
    int128 value,            // verdict.valueSigned (-100..+100)
    uint8 valueDecimals,     // verdict.valueDecimals
    string tag1,             // e.g. "audit"
    string tag2,             // e.g. "eu-ai-act"
    string endpoint,         // CAIP "eip155:84532:<auditorEoa>"
    string feedbackURI,      // anchors.storageURI (0G rootHash) — empty allowed
    bytes32 feedbackHash     // anchors.feedbackHash
) external;
```

The pair `(feedbackURI, feedbackHash)` is what regulators consume.
`feedbackURI = ""` is honest: "evidence in JSON return value, not pinned."
`feedbackHash = 0x0` is reserved for "no canonical report constructed."

## Regulator-side verification flow

```
1. Subscribe / scan AgentRegistry.NewFeedback events on 0G Galileo (chain 16602)
2. For each event, extract (agentId, feedbackURI, feedbackHash)
3. If feedbackURI == "" → bytes are not pinned. Either fail verification
   or accept that this audit only ran via MCP, not the orchestrator path.
4. Otherwise:
   a. Fetch bytes from 0G Storage indexer using rootHash = feedbackURI
      (e.g. https://indexer-storage-testnet-turbo.0g.ai)
   b. JSON.parse
   c. Recompute via canonicalizeAuditReport(parsed) — see source for the
      exact algorithm (deterministic in any language)
   d. Compare result.hash to feedbackHash from the event
   e. Match → these are the exact bytes the auditor signed for on-chain
5. Optionally cross-check evidenceChain.qwenInference.teeAttestation
   against 0G Compute provider's on-chain TEE pubkey (broker.processResponse
   or raw signature verification).
```

## Errors

| Kind | When | Source |
|---|---|---|
| `AuditReportError(missing_field, <path>)` | required slot absent or empty | `requireString` / `requireHex` (`audit-report.ts:364-380`) |
| `AuditReportError(invalid_hex, <path>)` | string present but doesn't match `0x[0-9a-fA-F]+`; OR `bigint` encountered during canonicalization | `requireHex` (`audit-report.ts:375`) + `canonicalJsonStringify` (`:198`) |
| `WriteAuditReportError(storage_disabled)` | `ZG_STORAGE_ENABLED !== '1'` and no explicit override | `writeAuditReport` (`audit-report.ts:288`) |
| `WriteAuditReportError(no_client)` | no `Storage0GClient` supplied | `writeAuditReport` (`audit-report.ts:297`) |
| `WriteAuditReportError(upload_failed, reason)` | underlying SDK upload threw | `writeAuditReport` (`audit-report.ts:319`) |

## Cross-references

- Production wiring: `apps/zhgg-mcp-adapter/src/index.ts:121-278`
  (`buildAuditFnOrNull` + `buildAnchor` callback into `runAudit`)
- Orchestrator wiring (full evidence chain): `apps/demo/src/cross-agent.ts`
- Storage adapter (live impl): `packages/workflow/src/storage-log-zg.ts`
  (ethers v6 + `@0gfoundation/0g-ts-sdk`, dynamic-imported)
- Tests: `packages/workflow/test/audit-report.test.ts`
- ERC-8004 cheat sheet: `docs/specs/EIP-8004.md`
- ERC-7857 (auditor + subject body): `docs/specs/EIP-7857.md`
- Storage Log encoding rules: `packages/workflow/src/storage-log.ts:18`
