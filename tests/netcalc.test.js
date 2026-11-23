'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../js/core/netcalc.js');

test('IPv4 CIDR math', () => {
  const r = N.calculate('192.168.1.130/26');
  assert.equal(r.cidr, '192.168.1.128/26');
  assert.equal(r.netmask, '255.255.255.192');
  assert.equal(r.wildcard, '0.0.0.63');
  assert.equal(r.broadcast, '192.168.1.191');
  assert.equal(r.first, '192.168.1.129');
  assert.equal(r.last, '192.168.1.190');
  assert.equal(r.usable, '62');
  assert.equal(r.total, '64');
  assert.equal(r.type, 'Private (RFC 1918)');
  assert.equal(r.isHostAddress, true);
});

test('IPv4 netmask forms, edge prefixes and address types', () => {
  assert.equal(N.calculate('10.0.0.5 255.255.255.0').cidr, '10.0.0.0/24');
  assert.equal(N.calculate('10.0.0.5/255.255.0.0').cidr, '10.0.0.0/16');
  const p31 = N.calculate('198.51.100.4/31');
  assert.deepEqual([p31.first, p31.last, p31.usable, p31.broadcast], ['198.51.100.4', '198.51.100.5', '2', null]);
  const host = N.calculate('8.8.8.8');
  assert.deepEqual([host.cidr, host.usable, host.type], ['8.8.8.8/32', '1', 'Public']);
  const all = N.calculate('0.0.0.0/0');
  assert.equal(all.total, '4294967296');
  assert.equal(all.broadcast, '255.255.255.255');
  assert.equal(N.calculate('100.100.1.1/10').type, 'Shared address space / CGNAT (RFC 6598)');
  assert.equal(N.calculate('169.254.10.1').type, 'Link-local (RFC 3927)');
  assert.equal(N.calculate('203.0.113.9').type, 'Documentation, TEST-NET-3 (RFC 5737)');
  assert.equal(N.calculate('255.255.255.255').type, 'Limited broadcast');
  assert.equal(N.calculate('239.1.1.1').type, 'Multicast');
});

test('IPv6 math and RFC 5952 formatting', () => {
  const r = N.calculate('2001:DB8:abcd:0012::1/48');
  assert.equal(r.address, '2001:db8:abcd:12::1');
  assert.equal(r.cidr, '2001:db8:abcd::/48');
  assert.equal(r.last, '2001:db8:abcd:ffff:ffff:ffff:ffff:ffff');
  assert.equal(r.totalPower, 80);
  assert.equal(r.type, 'Documentation (RFC 3849)');
  assert.equal(r.expanded, '2001:0db8:abcd:0012:0000:0000:0000:0001');
  assert.equal(N.calculate('2001:db8:0:0:1:0:0:1').address, '2001:db8::1:0:0:1');
  assert.equal(N.calculate('2001:db8:0:1:1:1:1:1').address, '2001:db8:0:1:1:1:1:1');
  assert.equal(N.calculate('::ffff:192.0.2.128/120').cidr, '::ffff:192.0.2.0/120');
  assert.equal(N.calculate('fe80::1/64').type, 'Link-local');
  assert.equal(N.calculate('fd12:3456::1').type, 'Unique local (RFC 4193)');
  assert.equal(N.calculate('::1').type, 'Loopback');
  assert.equal(N.calculate('::/0').total, (1n << 128n).toString());
});

test('contains() checks membership within one family', () => {
  const v4 = N.calculate('10.0.0.0/8');
  assert.equal(N.contains(v4, '10.255.0.1'), true);
  assert.equal(N.contains(v4, '11.0.0.1'), false);
  const v6 = N.calculate('2001:db8::/32');
  assert.equal(N.contains(v6, '2001:db8:ffff::1'), true);
  assert.equal(N.contains(v6, '2001:db9::1'), false);
  assert.throws(() => N.contains(v4, '2001:db8::1'), N.NetError);
  assert.throws(() => N.contains(v4, 'nope'), N.NetError);
  assert.throws(() => N.contains(null, '1.2.3.4'), N.NetError);
});

test('invalid input is rejected, not guessed at', () => {
  const bad = [
    null, '', '   ', 'abc', '1.2.3', '1.2.3.4.5', '1.2.3.256', '010.0.0.1', '0x7f.0.0.1', '1.2.3.4/33', '1.2.3.4/033',
    '1.2.3.4/-1', '1.2.3.4/255.0.255.0', '1.2.3.4/24/8', '1.2.3.4 24 extra',
    '1::2::3', '12345::', 'gggg::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', '2001:db8::1%eth0', '2001:db8::/129',
    '2001:db8:: 64', '1'.repeat(101), '::ffff:1.2.3.999',
  ];
  for (const b of bad) assert.throws(() => N.calculate(b), N.NetError, String(b));
});

test('summary and findNetworks', () => {
  assert.equal(N.summary(N.calculate('192.168.1.130/26')), [
    '- **Network:** 192.168.1.128/26',
    '- **Netmask:** 255.255.255.192 (wildcard 0.0.0.63)',
    '- **Usable range:** 192.168.1.129 – 192.168.1.190',
    '- **Broadcast:** 192.168.1.191',
    '- **Hosts:** 62 usable of 64',
    '- **Type:** Private (RFC 1918)',
  ].join('\n'));
  assert.match(N.summary(N.calculate('2001:db8::/64')), /Addresses:\*\* 2\^64 \(18,446,744,073,709,551,616\)/);
  const found = N.findNetworks('host 10.0.0.5/24 and fe80::1/64, at 12:30:45, v1.2.3.4.5, 999.1.1.1');
  assert.deepEqual(found.map((f) => f.value), ['10.0.0.5/24', 'fe80::1/64']);
  assert.equal(N.findNetworks('1.1.1.1 '.repeat(200)).length, 50);
});
