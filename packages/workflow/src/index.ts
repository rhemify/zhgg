export { inferZG } from './adapters/zg-router.js';
export type {
  FetchLike,
  Result,
  ZGInferenceResult,
  ZGRouterError,
  ZGRouterOptions,
} from './adapters/zg-router.js';

export { buildFeedbackJson, postReceipt } from './erc8004.js';
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
