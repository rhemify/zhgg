/// ERC-4337 v0.7 user operation builder + bundler client.
///
/// Builds a `PackedUserOperation` for `AgentSimpleAccount`, signs it with
/// the iNFT owner's EOA via viem, and submits via a public bundler RPC
/// (Pimlico's testnet endpoint by default — no API key required for
/// testnet methods).
///
/// "Real" means the JSON-RPC envelope, packing format, hash domain, and
/// signature scheme all match what the canonical EntryPoint at
/// `0x0000000071727De22E5E9d8BAf0edAc6f37da032` expects on Base Sepolia.
/// Live verification needs a real bundler round-trip; the unit tests
/// cover the build + sign + RPC-envelope shape with a stubbed `fetch`.

import {
  concatHex,
  encodeFunctionData,
  hexToBigInt,
  hexToBytes,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  toHex,
  type Account,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem';

/// v0.7 packed shape — exactly what AgentSimpleAccount.validateUserOp
/// receives.
export interface PackedUserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;     // 0x{verificationGasLimit:32}{callGasLimit:32}
  preVerificationGas: bigint;
  gasFees: Hex;              // 0x{maxPriorityFeePerGas:32}{maxFeePerGas:32}
  paymasterAndData: Hex;
  signature: Hex;
}

/// Same shape with `string` fields — what the bundler RPC accepts. We
/// translate to/from this on the wire.
export interface PackedUserOperationRpc {
  sender: Address;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: Hex;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

export interface BuildUserOpArgs {
  /// Address of the smart account (typically deployed via
  /// `AgentSimpleAccountFactory.predict`).
  sender: Address;
  /// The smart-account nonce — fetch from EntryPoint.getNonce(sender, 0).
  nonce: bigint;
  /// Encoded `execute(target, value, data)` or `executeBatch(...)` call.
  /// Pass `0x` for a no-op (validation-only).
  callData: Hex;
  /// Empty for already-deployed accounts; otherwise factory-encoded
  /// initCode = `factory || createAccount.selector || encode(owner, salt)`.
  initCode?: Hex;
  /// Gas knobs — caller is responsible for sizing. Pimlico's
  /// `pimlico_getUserOperationGasPrice` returns a sane default.
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  /// Paymaster bytes when sponsoring; `0x` otherwise.
  paymasterAndData?: Hex;
}

/// Pack a user operation for hashing + RPC submission. Output has empty
/// `signature` — caller signs separately and fills it in.
export function buildUserOp(args: BuildUserOpArgs): PackedUserOperation {
  return {
    sender: args.sender,
    nonce: args.nonce,
    initCode: args.initCode ?? '0x',
    callData: args.callData,
    accountGasLimits: packTwoUint128(args.verificationGasLimit, args.callGasLimit),
    preVerificationGas: args.preVerificationGas,
    gasFees: packTwoUint128(args.maxPriorityFeePerGas, args.maxFeePerGas),
    paymasterAndData: args.paymasterAndData ?? '0x',
    signature: '0x',
  };
}

/// Pack `(uint128, uint128)` into `bytes32` — high-order 16 bytes is the
/// first arg, low-order 16 bytes the second. This is the v0.7 encoding
/// AgentSimpleAccount and the canonical EntryPoint both expect.
export function packTwoUint128(high: bigint, low: bigint): Hex {
  if (high < 0n || high >= 1n << 128n) throw new Error('packTwoUint128: high overflow');
  if (low < 0n || low >= 1n << 128n) throw new Error('packTwoUint128: low overflow');
  return ('0x' +
    high.toString(16).padStart(32, '0') +
    low.toString(16).padStart(32, '0')) as Hex;
}

/// Compute the v0.7 userOpHash that the EntryPoint and the smart account
/// agree on. Hash domain:
///   keccak256(abi.encode(keccak256(packedFields), entryPoint, chainId))
/// where `packedFields` is the canonical packing the EntryPoint computes
/// before passing to the account.
export function userOpHash(op: PackedUserOperation, entryPoint: Address, chainId: number): Hex {
  const inner = keccak256(encodePackedFields(op));
  // abi.encode(bytes32, address, uint256) — strict ABI encoding
  const encoded = (inner +
    pad(entryPoint, { size: 32 }).slice(2) +
    pad(numberToHex(BigInt(chainId)), { size: 32 }).slice(2)) as Hex;
  return keccak256(encoded);
}

/// `keccak256(initCode)`, `keccak256(callData)`, `keccak256(paymasterAndData)`,
/// then ABI-encode-pack them together with the static fields. This MUST
/// match `EntryPoint.getUserOpHash` byte-for-byte.
function encodePackedFields(op: PackedUserOperation): Hex {
  const initCodeHash = keccak256(op.initCode);
  const callDataHash = keccak256(op.callData);
  const paymasterAndDataHash = keccak256(op.paymasterAndData);
  // sender(32) || nonce(32) || initCodeHash(32) || callDataHash(32) ||
  // accountGasLimits(32) || preVerificationGas(32) || gasFees(32) ||
  // paymasterAndDataHash(32)
  return concatHex([
    pad(op.sender, { size: 32 }),
    pad(numberToHex(op.nonce), { size: 32 }),
    initCodeHash,
    callDataHash,
    op.accountGasLimits,
    pad(numberToHex(op.preVerificationGas), { size: 32 }),
    op.gasFees,
    paymasterAndDataHash,
  ]);
}

/// Sign a UserOp via viem. The smart-account validates against the
/// `eth_sign`-style prefixed digest (matching `MessageHashUtils.toEthSignedMessageHash`
/// in AgentSimpleAccount).
export async function signUserOp(
  walletClient: WalletClient,
  account: Account,
  op: PackedUserOperation,
  entryPoint: Address,
  chainId: number
): Promise<Hex> {
  const hash = userOpHash(op, entryPoint, chainId);
  return walletClient.signMessage({
    account,
    message: { raw: hexToBytes(hash) },
  });
}

/// Convert a packed op to the bundler RPC shape (everything as hex
/// strings). The bundler expects this exact JSON layout per ERC-4337.
export function toRpcShape(op: PackedUserOperation): PackedUserOperationRpc {
  return {
    sender: op.sender,
    nonce: numberToHex(op.nonce),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: numberToHex(op.preVerificationGas),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
}

/// Encode `execute(target, value, data)` for AgentSimpleAccount.
export function encodeExecute(target: Address, value: bigint, data: Hex): Hex {
  return encodeFunctionData({
    abi: parseAbi(['function execute(address target, uint256 value, bytes data)']),
    functionName: 'execute',
    args: [target, value, data],
  });
}

/// Encode `executeBatch(targets, values, datas)` for AgentSimpleAccount.
export function encodeExecuteBatch(
  targets: readonly Address[],
  values: readonly bigint[],
  datas: readonly Hex[]
): Hex {
  return encodeFunctionData({
    abi: parseAbi([
      'function executeBatch(address[] targets, uint256[] values, bytes[] datas)',
    ]),
    functionName: 'executeBatch',
    args: [[...targets], [...values], [...datas]],
  });
}

/// Encode the AgentSimpleAccountFactory `createAccount(owner, salt)` call
/// + the factory address — the v0.7 `initCode` field for first-op deploy.
export function encodeInitCode(factory: Address, owner: Address, salt: Hex): Hex {
  const data = encodeFunctionData({
    abi: parseAbi(['function createAccount(address owner, bytes32 salt)']),
    functionName: 'createAccount',
    args: [owner, salt],
  });
  return concatHex([factory, data]);
}

// ---------------------------------------------------------------------
// Bundler RPC client
// ---------------------------------------------------------------------

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type BundlerError =
  | { kind: 'transport'; reason: string }
  | { kind: 'rpc_error'; code: number; message: string }
  | { kind: 'malformed'; reason: string };

export type BundlerOutcome<T> = { ok: true; value: T } | { ok: false; error: BundlerError };

export interface BundlerOptions {
  bundlerUrl: string;
  fetchImpl?: FetchLike;
}

/// Submit a signed UserOp to the bundler. Returns the userOpHash that
/// can be polled via `eth_getUserOperationReceipt`. Real RPC call —
/// `fetchImpl` is the only test seam.
export async function sendUserOperation(
  op: PackedUserOperation,
  entryPoint: Address,
  opts: BundlerOptions
): Promise<BundlerOutcome<Hex>> {
  return rpcCall<Hex>(opts, 'eth_sendUserOperation', [toRpcShape(op), entryPoint]);
}

/// Poll for a UserOp receipt. Returns null when the bundler hasn't
/// included the op yet (the caller polls).
export async function getUserOperationReceipt(
  userOpHash: Hex,
  opts: BundlerOptions
): Promise<BundlerOutcome<unknown | null>> {
  return rpcCall<unknown | null>(opts, 'eth_getUserOperationReceipt', [userOpHash]);
}

/// Pimlico-specific gas-price helper. Returns slow / standard / fast
/// triplets; caller picks one based on intent.max_latency_ms.
export interface PimlicoGasPrice {
  slow: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
  standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
  fast: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
}

export async function pimlicoGetUserOperationGasPrice(
  opts: BundlerOptions
): Promise<BundlerOutcome<PimlicoGasPrice>> {
  return rpcCall<PimlicoGasPrice>(opts, 'pimlico_getUserOperationGasPrice', []);
}

/// Exported so `paymaster.ts` can issue Pimlico-specific JSON-RPC calls
/// without redefining the boilerplate. Wraps fetch + JSON-RPC envelope
/// + error normalization into a single `BundlerOutcome<T>`.
export async function rpcCall<T>(
  opts: BundlerOptions,
  method: string,
  params: readonly unknown[]
): Promise<BundlerOutcome<T>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(opts.bundlerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch (e) {
    return {
      ok: false,
      error: { kind: 'transport', reason: e instanceof Error ? e.message : String(e) },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: { kind: 'transport', reason: `bundler returned HTTP ${res.status}` },
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return {
      ok: false,
      error: { kind: 'malformed', reason: e instanceof Error ? e.message : String(e) },
    };
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: { kind: 'malformed', reason: 'response not an object' } };
  }
  const error = (body as { error?: unknown }).error;
  if (error && typeof error === 'object') {
    const code =
      typeof (error as { code?: unknown }).code === 'number'
        ? ((error as { code: number }).code)
        : -1;
    const message =
      typeof (error as { message?: unknown }).message === 'string'
        ? ((error as { message: string }).message)
        : 'unknown rpc error';
    return { ok: false, error: { kind: 'rpc_error', code, message } };
  }
  const result = (body as { result?: unknown }).result;
  return { ok: true, value: result as T };
}

/// Read the EntryPoint's `getNonce(sender, key)` view via a public
/// JSON-RPC eth_call. Returns the nonce as a bigint. The `key` arg
/// scopes parallel ops; pass 0 for sequential nonces.
export async function getEntryPointNonce(args: {
  rpcUrl: string;
  entryPoint: Address;
  sender: Address;
  key?: bigint;
  fetchImpl?: FetchLike;
}): Promise<BundlerOutcome<bigint>> {
  const fetchImpl = args.fetchImpl ?? fetch;
  // selector for getNonce(address,uint192)
  const selector: Hex = '0x35567e1a';
  const callData = (selector +
    pad(args.sender, { size: 32 }).slice(2) +
    pad(numberToHex(args.key ?? 0n), { size: 32 }).slice(2)) as Hex;
  let res: Response;
  try {
    res = await fetchImpl(args.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: args.entryPoint, data: callData }, 'latest'],
      }),
    });
  } catch (e) {
    return {
      ok: false,
      error: { kind: 'transport', reason: e instanceof Error ? e.message : String(e) },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: { kind: 'transport', reason: `RPC returned HTTP ${res.status}` },
    };
  }
  let body: { result?: unknown; error?: unknown };
  try {
    body = (await res.json()) as { result?: unknown; error?: unknown };
  } catch (e) {
    return {
      ok: false,
      error: { kind: 'malformed', reason: e instanceof Error ? e.message : String(e) },
    };
  }
  if (typeof body.result !== 'string') {
    return { ok: false, error: { kind: 'malformed', reason: 'no result' } };
  }
  return { ok: true, value: hexToBigInt(body.result as Hex) };
}

/// Canonical ERC-4337 v0.7 EntryPoint address — same on every EVM chain.
export const ENTRYPOINT_V07_ADDRESS: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

/// Pimlico free public bundler endpoints. Testnet methods (the paymaster
/// stubs + sendUserOperation) work without an API key. Mainnet methods
/// require `?apikey=...`.
export function pimlicoBundlerUrl(chainId: number, apiKey?: string): string {
  const base = `https://api.pimlico.io/v2/${chainId}/rpc`;
  return apiKey ? `${base}?apikey=${apiKey}` : base;
}

/// Free public RPC for Base Sepolia EntryPoint reads. Override per env.
export const BASE_SEPOLIA_RPC_DEFAULT = 'https://sepolia.base.org';

// Re-export low-level toHex for tests that need to assert byte shapes.
export { toHex };
