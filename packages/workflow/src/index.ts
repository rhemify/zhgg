export { inferZG } from './adapters/zg-router.js';
export type {
  FetchLike,
  Result,
  ZGInferenceResult,
  ZGRouterError,
  ZGRouterOptions,
} from './adapters/zg-router.js';

export { buildFeedbackJson, postReceipt } from './erc8004.js';
export { canonicalizeAuditPayload, writeAuditLog } from './storage-log.js';
export {
  AuditReportError,
  buildAuditReport,
  canonicalJsonStringify,
  canonicalizeAuditReport,
  writeAuditReport,
} from './audit-report.js';
export type {
  AuditReport,
  AuditReportFinding,
  BuildAuditReportInput,
  CanonicalAuditReport,
  FindingStatus,
  WriteAuditReportError,
  WriteAuditReportOptions,
  WriteAuditReportSuccess,
} from './audit-report.js';
export type {
  AuditLogPayload,
  Storage0GClient,
  StorageError,
  WriteAuditLogOptions,
  WriteAuditLogSuccess,
} from './storage-log.js';

export { verifyTeeAttestation } from './tee-attestation.js';
export type {
  AttestError,
  TeeAttestationEnvelope,
  VerifiedAttestation,
  VerifyOptions as TeeVerifyOptions,
} from './tee-attestation.js';
export type {
  Erc8004Client,
  FeedbackJsonInput,
  GiveFeedbackArgs,
  PostError,
  ReceiptContext,
} from './erc8004.js';

export {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  buildPaymentRequirements,
  payment402,
  paymentFingerprint,
  paymentResponseHeader,
  settlePayment,
  verifyPayment,
} from './x402.js';
export type {
  PaymentRequirements,
  PaymentRequirementsInput,
  SettleError,
  SettleOptions,
  SettleOutput,
  VerifyOptions,
  VerifyOutcome,
} from './x402.js';

export { buildRegistry, callTool, listTools } from './registry.js';
export type {
  JsonSchema,
  JsonSchemaField,
  PluginRegistry,
  RegisteredTool,
  ToolDescriptor,
} from './registry.js';
export type { Action, ConfigField, IntegrationPlugin, OutputField } from './plugin-types.js';
export { createMcpServer } from './mcp-server.js';
export type { CreateMcpServerOptions } from './mcp-server.js';

export {
  DELEGATION_TYPES,
  MODE_SINGLE_CALL,
  delegationDigest,
  encodeExecution,
  encodePermissionContext,
  signDelegation,
} from './delegation.js';
export type { Delegation, DelegationDomain, Execution } from './delegation.js';

export {
  PAYMENT_INTENT_TYPES,
  createInMemoryNonceStore,
  feeSplitterExecutor,
  paymentIntentDigest,
  relayPaymentIntent,
} from './multi-leg-relay.js';

export {
  SPOKE_POOL,
  SPOKE_POOL_ABI,
  bridgeViaAcross,
  caip2ToChainId,
  spokePoolFor,
  waitForFill,
} from './across.js';
export type {
  BridgeArgs,
  BridgeError,
  BridgeOutcome,
  BridgeResult,
  WaitForFillArgs,
  WaitForFillError,
  WaitForFillOutcome,
} from './across.js';
export type {
  ChainExecutor,
  InMemoryNonceStore,
  IntentDomain,
  NonceStore,
  PaymentIntent,
  PaymentLeg,
  RelayDeps,
  RelayError,
  RelayLegResult,
  RelayOutcome,
} from './multi-leg-relay.js';
