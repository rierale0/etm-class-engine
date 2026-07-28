import { describe, expect, it } from 'vitest';
import {
  isIpAllowed,
  parseCidrs,
  safeHexEqual,
  signCallback,
  signRequest,
  verifyRequestSignature,
} from './index.js';

const secret = 'a'.repeat(32);

describe('request HMAC', () => {
  it('generates and verifies the canonical signature', () => {
    const timestamp = '1770000000';
    const signature = signRequest(secret, timestamp, 'POST', '/v1/classes/abc/analyze', '{}');
    expect(
      verifyRequestSignature({
        secret,
        timestamp,
        signature,
        method: 'POST',
        requestPath: '/v1/classes/abc/analyze',
        rawBody: '{}',
        now: new Date(1770000000 * 1000),
      }),
    ).toBe(true);
  });

  it('rejects stale timestamps and malformed signatures', () => {
    expect(
      verifyRequestSignature({
        secret,
        timestamp: '1700000000',
        signature: '0'.repeat(64),
        method: 'GET',
        requestPath: '/v1/jobs/x',
        rawBody: '',
        now: new Date(1770000000 * 1000),
      }),
    ).toBe(false);
    expect(safeHexEqual('0'.repeat(64), 'bad')).toBe(false);
    expect(safeHexEqual('0'.repeat(64), '0'.repeat(64))).toBe(true);
  });
});

describe('CIDR allowlist', () => {
  const cidrs = parseCidrs(['127.0.0.1/32', '10.10.0.0/16', '2001:db8::/32']);

  it('supports IPv4, IPv6 and mapped IPv4', () => {
    expect(isIpAllowed('10.10.2.3', cidrs)).toBe(true);
    expect(isIpAllowed('10.11.2.3', cidrs)).toBe(false);
    expect(isIpAllowed('2001:db8::42', cidrs)).toBe(true);
    expect(isIpAllowed('::ffff:127.0.0.1', cidrs)).toBe(true);
  });
});

it('signs callbacks over timestamp and body hash', () => {
  expect(signCallback(secret, '1770000000', '{}')).toHaveLength(64);
  expect(signCallback(secret, '1770000000', '{}')).not.toBe(
    signCallback(secret, '1770000001', '{}'),
  );
});
