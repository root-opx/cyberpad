/*
 * Subnet calculator for IPv4 and IPv6. Addresses, prefixes and netmasks are
 * parsed strictly (no octal or hex IPv4 forms, no zone IDs, no leading zeros);
 * anything else is rejected rather than guessed at.
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).netcalc = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class NetError extends Error {
    constructor(message) { super(message); this.name = 'NetError'; }
  }

  const MAX_INPUT = 100;
  const MAX_FOUND = 50;
  const ALL6 = (1n << 128n) - 1n;

  // ---- IPv4 --------------------------------------------------------------

  function parseIPv4(s) {
    if (typeof s !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) throw new NetError(`"${clip(s)}" is not an IPv4 address.`);
    let n = 0;
    for (const part of s.split('.')) {
      if (part.length > 1 && part[0] === '0') throw new NetError(`"${clip(s)}" has a leading zero, which some tools read as octal. Write it without leading zeros.`);
      const v = Number(part);
      if (v > 255) throw new NetError(`"${clip(s)}" is not an IPv4 address: each part must be 0 to 255.`);
      n = n * 256 + v;
    }
    return n;
  }

  const fmt4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  const mask4 = (p) => (p === 0 ? 0 : (0xFFFFFFFF << (32 - p)) >>> 0);

  function prefixFromMask(maskStr) {
    const m = parseIPv4(maskStr);
    const inv = (~m) >>> 0;
    if ((inv & (inv + 1)) !== 0) throw new NetError(`${maskStr} is not a valid netmask: the 1 bits must be contiguous, like 255.255.255.0.`);
    let p = 32;
    for (let x = inv; x; x >>>= 1) p--;
    return p;
  }

  const V4_TYPES = [
    ['0.0.0.0', 8, 'This network (RFC 1122)'],
    ['10.0.0.0', 8, 'Private (RFC 1918)'],
    ['100.64.0.0', 10, 'Shared address space / CGNAT (RFC 6598)'],
    ['127.0.0.0', 8, 'Loopback'],
    ['169.254.0.0', 16, 'Link-local (RFC 3927)'],
    ['172.16.0.0', 12, 'Private (RFC 1918)'],
    ['192.0.0.0', 24, 'IETF protocol assignments (RFC 6890)'],
    ['192.0.2.0', 24, 'Documentation, TEST-NET-1 (RFC 5737)'],
    ['192.168.0.0', 16, 'Private (RFC 1918)'],
    ['198.18.0.0', 15, 'Benchmarking (RFC 2544)'],
    ['198.51.100.0', 24, 'Documentation, TEST-NET-2 (RFC 5737)'],
    ['203.0.113.0', 24, 'Documentation, TEST-NET-3 (RFC 5737)'],
    ['224.0.0.0', 4, 'Multicast'],
    ['255.255.255.255', 32, 'Limited broadcast'],
    ['240.0.0.0', 4, 'Reserved (RFC 1112)'],
  ].map(([a, p, label]) => ({ net: parseIPv4(a), mask: mask4(p), label }));

  function typeOf4(n) {
    const hit = V4_TYPES.find((t) => ((n & t.mask) >>> 0) === t.net);
    return hit ? hit.label : 'Public';
  }

  function calc4(addrStr, prefix) {
    const addr = parseIPv4(addrStr);
    const mask = mask4(prefix);
    const network = (addr & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    const total = 2 ** (32 - prefix);
    let first = network;
    let last = broadcast;
    let usable = total;
    if (prefix <= 30) { first = network + 1; last = broadcast - 1; usable = total - 2; }
    return {
      family: 4,
      address: fmt4(addr),
      prefix,
      cidr: `${fmt4(network)}/${prefix}`,
      network: fmt4(network),
      broadcast: prefix <= 30 ? fmt4(broadcast) : null,
      netmask: fmt4(mask),
      wildcard: fmt4((~mask) >>> 0),
      first: fmt4(first),
      last: fmt4(last),
      total: String(total),
      usable: String(usable),
      type: typeOf4(addr),
      isHostAddress: addr !== network && prefix < 32,
      _net: BigInt(network),
      _mask: BigInt(mask),
    };
  }

  // ---- IPv6 --------------------------------------------------------------

  function parseIPv6(input) {
    if (typeof input !== 'string' || input.length > 45 || input.length < 2) throw new NetError(`"${clip(input)}" is not an IPv6 address.`);
    if (input.includes('%')) throw new NetError('Zone IDs (the %eth0 part) are not supported. Remove them.');
    let s = input.toLowerCase();
    const v4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
    if (v4) {
      const n = parseIPv4(v4[1]);
      s = `${s.slice(0, v4.index + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
    }
    const halves = s.split('::');
    if (halves.length > 2) throw new NetError(`"${clip(input)}" is not an IPv6 address: "::" can appear only once.`);
    const groups = (part) => (part === '' ? [] : part.split(':'));
    const head = groups(halves[0]);
    const tail = halves.length === 2 ? groups(halves[1]) : [];
    for (const g of [...head, ...tail]) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) throw new NetError(`"${clip(input)}" is not an IPv6 address.`);
    }
    if (halves.length === 1 && head.length !== 8) throw new NetError(`"${clip(input)}" is not an IPv6 address: it needs 8 groups, or "::".`);
    if (halves.length === 2 && head.length + tail.length > 7) throw new NetError(`"${clip(input)}" is not an IPv6 address: too many groups.`);
    const all = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
    return all.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
  }

  /** RFC 5952 text form: lowercase, longest zero run compressed, IPv4-mapped in dotted form. */
  function fmt6(n) {
    const g = [];
    for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn));
    if (n >> 32n === 0xffffn) return `::ffff:${fmt4(Number(n & 0xffffffffn))}`;
    let best = -1;
    let bestLen = 1;
    for (let i = 0; i < 8;) {
      if (g[i] !== 0) { i++; continue; }
      let j = i;
      while (j < 8 && g[j] === 0) j++;
      if (j - i > bestLen) { best = i; bestLen = j - i; }
      i = j;
    }
    const hex = g.map((x) => x.toString(16));
    if (best < 0) return hex.join(':');
    return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
  }

  const expand6 = (n) => n.toString(16).padStart(32, '0').match(/.{4}/g).join(':');
  const mask6 = (p) => (p === 0 ? 0n : (ALL6 << BigInt(128 - p)) & ALL6);

  const V6_TYPES = [
    ['::', 128, 'Unspecified'],
    ['::1', 128, 'Loopback'],
    ['::ffff:0:0', 96, 'IPv4-mapped'],
    ['64:ff9b::', 96, 'NAT64 (RFC 6052)'],
    ['2001::', 32, 'Teredo (RFC 4380)'],
    ['2001:db8::', 32, 'Documentation (RFC 3849)'],
    ['2002::', 16, '6to4 (RFC 3056)'],
    ['fc00::', 7, 'Unique local (RFC 4193)'],
    ['fe80::', 10, 'Link-local'],
    ['ff00::', 8, 'Multicast'],
    ['2000::', 3, 'Global unicast'],
  ].map(([a, p, label]) => ({ net: parseIPv6(a), mask: mask6(p), label }));

  function typeOf6(n) {
    const hit = V6_TYPES.find((t) => (n & t.mask) === t.net);
    return hit ? hit.label : 'Reserved';
  }

  function calc6(addrStr, prefix) {
    const addr = parseIPv6(addrStr);
    const mask = mask6(prefix);
    const network = addr & mask;
    const last = network | (~mask & ALL6);
    const total = 1n << BigInt(128 - prefix);
    return {
      family: 6,
      address: fmt6(addr),
      expanded: expand6(addr),
      prefix,
      cidr: `${fmt6(network)}/${prefix}`,
      network: fmt6(network),
      broadcast: null,
      netmask: fmt6(mask),
      wildcard: null,
      first: fmt6(network),
      last: fmt6(last),
      total: total.toString(),
      usable: total.toString(),
      totalPower: 128 - prefix,
      type: typeOf6(addr),
      isHostAddress: addr !== network && prefix < 128,
      _net: network,
      _mask: mask,
    };
  }

  // ---- input -------------------------------------------------------------

  function clip(s) {
    const t = String(s);
    return t.length > 45 ? `${t.slice(0, 45)}…` : t;
  }

  function parsePrefix(raw, max) {
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > max || (raw.length > 1 && raw[0] === '0')) {
      throw new NetError(`The prefix length must be a whole number from 0 to ${max}.`);
    }
    return Number(raw);
  }

  /**
   * Accepts "10.0.0.5/24", "10.0.0.5/255.255.255.0", "10.0.0.5 255.255.255.0",
   * "2001:db8::1/48", or a bare address (treated as a single host).
   */
  function calculate(input) {
    if (typeof input !== 'string') throw new NetError('Enter an address or network as text.');
    const s = input.trim();
    if (!s) throw new NetError('Enter a network such as 192.168.10.0/24 or 2001:db8::/48.');
    if (s.length > MAX_INPUT) throw new NetError('That is too long to be an address or network.');
    const m = /^([^\s/]+)(?:\s*\/\s*([^\s/]+)|\s+([^\s/]+))?$/.exec(s);
    if (!m) throw new NetError('Use the form 192.168.10.0/24, 192.168.10.0 255.255.255.0, or 2001:db8::/48.');
    const [, addr, slashPart, spacePart] = m;
    if (addr.includes(':')) {
      if (spacePart !== undefined) throw new NetError('For IPv6, write the prefix length after a slash, like 2001:db8::/48.');
      return calc6(addr, slashPart === undefined ? 128 : parsePrefix(slashPart, 128));
    }
    const maskPart = slashPart !== undefined ? slashPart : spacePart;
    let prefix = 32;
    if (maskPart !== undefined) prefix = maskPart.includes('.') ? prefixFromMask(maskPart) : parsePrefix(maskPart, 32);
    return calc4(addr, prefix);
  }

  /** Whether an address falls inside a result from calculate(). */
  function contains(result, addrInput) {
    if (!result || (result.family !== 4 && result.family !== 6)) throw new NetError('Calculate a network first.');
    if (typeof addrInput !== 'string' || addrInput.trim().length > 45) throw new NetError('Enter a single address.');
    const a = addrInput.trim();
    const isV6 = a.includes(':');
    if ((result.family === 6) !== isV6) throw new NetError(`That is an IPv${isV6 ? 6 : 4} address, but the network is IPv${result.family}.`);
    const n = isV6 ? parseIPv6(a) : BigInt(parseIPv4(a));
    return (n & result._mask) === result._net;
  }

  /** Text summary for pasting into a report. */
  function summary(r) {
    const lines = [`- **Network:** ${r.cidr}`];
    if (r.family === 4) {
      lines.push(`- **Netmask:** ${r.netmask} (wildcard ${r.wildcard})`);
      lines.push(`- **Usable range:** ${r.first} – ${r.last}`);
      if (r.broadcast) lines.push(`- **Broadcast:** ${r.broadcast}`);
      lines.push(`- **Hosts:** ${Number(r.usable).toLocaleString('en-US')} usable of ${Number(r.total).toLocaleString('en-US')}`);
    } else {
      lines.push(`- **Range:** ${r.first} – ${r.last}`);
      lines.push(`- **Addresses:** 2^${r.totalPower}${r.totalPower <= 64 ? ` (${BigInt(r.total).toLocaleString('en-US')})` : ''}`);
    }
    lines.push(`- **Type:** ${r.type}`);
    return lines.join('\n');
  }

  /** Valid networks and addresses in text, with offsets. */
  function findNetworks(text) {
    const out = [];
    if (typeof text !== 'string') return out;
    const re = /(?<![\w.:])(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}(?::\d{1,3}(?:\.\d{1,3}){3})?(?:\/\d{1,3})?)(?![\w.:])/g;
    let m;
    let tries = 0;
    while ((m = re.exec(text)) && out.length < MAX_FOUND && tries++ < 1000) {
      try {
        calculate(m[0]);
        out.push({ value: m[0], index: m.index });
      } catch (err) {
        if (!(err instanceof NetError)) throw err;
      }
    }
    return out;
  }

  return { NetError, MAX_INPUT, calculate, contains, summary, findNetworks, parseIPv4, parseIPv6, fmt6 };
});
