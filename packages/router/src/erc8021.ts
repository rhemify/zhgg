import {
  ZHGG_ERC8021_MARKER,
  loadEnv,
} from './constants.js';

export interface FeeSuffix {
  marker: string;
  recipient: string;
  bps: number;
}

export interface AppendFeeOptions {
  recipient?: string;
  bps?: number;
}

const HEX_BODY = /^[0-9a-fA-F]*$/;
const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SUFFIX_HEX_LEN = 48;
const MARKER_HEX_LEN = 4;
const ADDRESS_HEX_LEN = 40;
const BPS_HEX_LEN = 4;
const MAX_BPS = 10_000;

function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

export function appendFee(calldata: string, opts?: AppendFeeOptions): string {
  const body = stripHexPrefix(calldata);
  if (body.length % 2 !== 0 || !HEX_BODY.test(body)) {
    throw new Error('erc8021: invalid calldata hex');
  }

  const env = loadEnv();
  const recipient = opts?.recipient ?? env.ZHGG_FEE_RECIPIENT;
  const bps = opts?.bps ?? env.ZHGG_FEE_BPS;

  if (!HEX_ADDRESS_RE.test(recipient)) {
    throw new Error('erc8021: invalid fee recipient address');
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_BPS) {
    throw new Error('erc8021: bps must be an integer between 0 and 10000');
  }

  const recipientHex = stripHexPrefix(recipient).toLowerCase();
  // BPS is a uint16 big-endian — high byte first, low byte second.
  const bpsHex = bps.toString(16).padStart(BPS_HEX_LEN, '0').toLowerCase();
  const markerHex = ZHGG_ERC8021_MARKER.toLowerCase();

  return `0x${body.toLowerCase()}${markerHex}${recipientHex}${bpsHex}`;
}

export function parseFee(
  calldata: string,
): { stripped: string; suffix: FeeSuffix } | null {
  try {
    const body = stripHexPrefix(calldata);
    if (body.length < SUFFIX_HEX_LEN) return null;
    if (body.length % 2 !== 0) return null;
    if (!HEX_BODY.test(body)) return null;

    const suffix = body.slice(body.length - SUFFIX_HEX_LEN);
    const marker = suffix.slice(0, MARKER_HEX_LEN);
    if (marker.toLowerCase() !== ZHGG_ERC8021_MARKER.toLowerCase()) {
      return null;
    }

    const recipientHex = suffix.slice(
      MARKER_HEX_LEN,
      MARKER_HEX_LEN + ADDRESS_HEX_LEN,
    );
    const bpsHex = suffix.slice(MARKER_HEX_LEN + ADDRESS_HEX_LEN);
    const bps = parseInt(bpsHex, 16);
    if (!Number.isFinite(bps) || Number.isNaN(bps)) return null;

    const stripped = `0x${body.slice(0, body.length - SUFFIX_HEX_LEN)}`;
    return {
      stripped,
      suffix: {
        marker: marker.toLowerCase(),
        recipient: `0x${recipientHex.toLowerCase()}`,
        bps,
      },
    };
  } catch {
    return null;
  }
}

export function detectFee(calldata: string): FeeSuffix | null {
  const result = parseFee(calldata);
  return result?.suffix ?? null;
}

export function computeFeeAmount(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}
