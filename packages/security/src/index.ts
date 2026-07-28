import { createHash, createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import ipaddr from 'ipaddr.js';

export const AUTH_MAX_AGE_SECONDS = 300;

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalRequest(
  timestamp: string,
  method: string,
  requestPath: string,
  rawBody: string | Buffer,
): string {
  return `${timestamp}\n${method.toUpperCase()}\n${requestPath}\n${sha256(rawBody)}`;
}

export function signRequest(
  secret: string,
  timestamp: string,
  method: string,
  requestPath: string,
  rawBody: string | Buffer,
): string {
  return createHmac('sha256', secret)
    .update(canonicalRequest(timestamp, method, requestPath, rawBody))
    .digest('hex');
}

export function safeHexEqual(expectedHex: string, suppliedHex: string): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(expectedHex) || !/^[a-fA-F0-9]{64}$/.test(suppliedHex)) {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  const supplied = Buffer.from(suppliedHex, 'hex');
  return expected.length === supplied.length && nodeTimingSafeEqual(expected, supplied);
}

export function verifyRequestSignature(input: {
  secret: string;
  timestamp: string;
  signature: string;
  method: string;
  requestPath: string;
  rawBody: string | Buffer;
  now?: Date;
}): boolean {
  if (!/^\d{10,13}$/.test(input.timestamp)) return false;
  const numeric = Number(input.timestamp);
  const timestampMs = input.timestamp.length === 13 ? numeric : numeric * 1000;
  const nowMs = (input.now ?? new Date()).getTime();
  if (Math.abs(nowMs - timestampMs) > AUTH_MAX_AGE_SECONDS * 1000) return false;

  const expected = signRequest(
    input.secret,
    input.timestamp,
    input.method,
    input.requestPath,
    input.rawBody,
  );
  return safeHexEqual(expected, input.signature);
}

export function requestPayloadHash(
  method: string,
  requestPath: string,
  rawBody: string | Buffer,
): string {
  return sha256(`${method.toUpperCase()}\n${requestPath}\n${sha256(rawBody)}`);
}

export interface ParsedCidr {
  address: ipaddr.IPv4 | ipaddr.IPv6;
  prefixLength: number;
}

export function parseCidrs(values: string[]): ParsedCidr[] {
  return values.map((value) => {
    const [address, prefixLength] = ipaddr.parseCIDR(value);
    return { address: normalizeAddress(address), prefixLength };
  });
}

export function isIpAllowed(ip: string, cidrs: ParsedCidr[]): boolean {
  let address: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    address = normalizeAddress(ipaddr.parse(stripZone(ip)));
  } catch {
    return false;
  }
  return cidrs.some((cidr) => {
    if (address.kind() !== cidr.address.kind()) return false;
    return address.match(cidr.address, cidr.prefixLength);
  });
}

export function signCallback(secret: string, timestamp: string, body: string | Buffer): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${sha256(body)}`)
    .digest('hex');
}

function normalizeAddress(address: ipaddr.IPv4 | ipaddr.IPv6): ipaddr.IPv4 | ipaddr.IPv6 {
  if (address.kind() === 'ipv6') {
    const ipv6 = address as ipaddr.IPv6;
    return ipv6.isIPv4MappedAddress() ? ipv6.toIPv4Address() : ipv6;
  }
  return address;
}

function stripZone(ip: string): string {
  const zone = ip.indexOf('%');
  return zone === -1 ? ip : ip.slice(0, zone);
}
