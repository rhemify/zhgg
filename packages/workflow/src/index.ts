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
