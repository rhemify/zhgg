import { describe, it, expect } from 'bun:test';
import {
  resolveEnsAgent,
  type EnsProviderLike,
  type EnsResolverLike,
} from '../../src/identity/ens.js';

function makeProvider(records: Record<string, string> | null): EnsProviderLike {
  return {
    async getResolver() {
      if (records === null) return null;
      return makeResolver(records);
    },
  };
}

function makeResolver(records: Record<string, string>): EnsResolverLike {
  return {
    async getText(key: string) {
      return records[key] ?? null;
    },
  };
}

const VALID_INFT = '16602:0x' + 'a'.repeat(40) + ':1';

describe('resolveEnsAgent — happy path', () => {
  it('parses zhgg.inft record into chainId / contract / tokenId', async () => {
    const r = await resolveEnsAgent(
      'agent.zhgg.eth',
      makeProvider({ 'zhgg.inft': VALID_INFT }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ensName).toBe('agent.zhgg.eth');
      expect(r.value.inft.chainId).toBe(16602);
      expect(r.value.inft.contractAddress).toBe('0x' + 'a'.repeat(40));
      expect(r.value.inft.tokenId).toBe('1');
    }
  });

  it('parses optional modes / cost / latency records', async () => {
    const r = await resolveEnsAgent(
      'agent.zhgg.eth',
      makeProvider({
        'zhgg.inft': VALID_INFT,
        'zhgg.modes': 'fast,verified, consensus',
        'zhgg.maxCostUsd': '0.005',
        'zhgg.maxLatencyMs': '5000',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.allowedModes).toEqual(['fast', 'verified', 'consensus']);
      expect(r.value.maxCostUsd).toBe(0.005);
      expect(r.value.maxLatencyMs).toBe(5000);
    }
  });

  it('defaults optional fields to safe values when absent', async () => {
    const r = await resolveEnsAgent(
      'agent.zhgg.eth',
      makeProvider({ 'zhgg.inft': VALID_INFT }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.allowedModes).toEqual([]);
      expect(r.value.maxCostUsd).toBeNull();
      expect(r.value.maxLatencyMs).toBeNull();
    }
  });

  it('filters unknown modes from zhgg.modes', async () => {
    const r = await resolveEnsAgent(
      'agent.zhgg.eth',
      makeProvider({
        'zhgg.inft': VALID_INFT,
        'zhgg.modes': 'fast, turbo, consensus',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.allowedModes).toEqual(['fast', 'consensus']);
  });

  it('rejects non-numeric maxCostUsd by returning null', async () => {
    const r = await resolveEnsAgent(
      'agent.zhgg.eth',
      makeProvider({
        'zhgg.inft': VALID_INFT,
        'zhgg.maxCostUsd': 'not-a-number',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.maxCostUsd).toBeNull();
  });

  it('rejects negative maxLatencyMs by returning null', async () => {
    const r = await resolveEnsAgent(
      'agent.zhgg.eth',
      makeProvider({
        'zhgg.inft': VALID_INFT,
        'zhgg.maxLatencyMs': '-100',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.maxLatencyMs).toBeNull();
  });
});

describe('resolveEnsAgent — error paths', () => {
  it('returns no_resolver when getResolver returns null', async () => {
    const r = await resolveEnsAgent('nope.eth', makeProvider(null));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('no_resolver');
  });

  it('returns missing_inft when zhgg.inft record absent', async () => {
    const r = await resolveEnsAgent(
      'agent.zhgg.eth',
      makeProvider({ 'zhgg.modes': 'fast' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('missing_inft');
  });

  it('returns missing_inft when zhgg.inft is empty string', async () => {
    const r = await resolveEnsAgent(
      'agent.zhgg.eth',
      makeProvider({ 'zhgg.inft': '' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('missing_inft');
  });

  it('returns malformed when zhgg.inft has wrong shape', async () => {
    const r = await resolveEnsAgent(
      'agent.zhgg.eth',
      makeProvider({ 'zhgg.inft': 'not-the-right-format' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });

  it('returns malformed on bad address length', async () => {
    const r = await resolveEnsAgent(
      'agent.zhgg.eth',
      makeProvider({ 'zhgg.inft': '16602:0xshort:1' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });

  it('returns transport when getResolver throws', async () => {
    const provider: EnsProviderLike = {
      async getResolver() {
        throw new Error('rpc down');
      },
    };
    const r = await resolveEnsAgent('agent.zhgg.eth', provider);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('transport');
      expect(r.error.reason).toContain('rpc down');
    }
  });

  it('treats getText throws as missing record (not transport)', async () => {
    const resolver: EnsResolverLike = {
      async getText(key: string) {
        if (key === 'zhgg.inft') return VALID_INFT;
        throw new Error('flaky');
      },
    };
    const r = await resolveEnsAgent('agent.zhgg.eth', {
      async getResolver() {
        return resolver;
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.allowedModes).toEqual([]);
      expect(r.value.maxCostUsd).toBeNull();
    }
  });
});
