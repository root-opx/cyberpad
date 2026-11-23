'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/core/secops.js');

// Token-shaped strings are built at runtime so this file never contains a
// literal that secret scanners (or GitHub push protection) would flag.
const fake = {
  aws: ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join(''),
  github: ['gh', 'p_', 'a'.repeat(36)].join(''),
  slack: ['xo', 'xb-', '1234567890-abcdefghij'].join(''),
  google: ['AI', 'za', 'B'.repeat(35)].join(''),
  stripe: ['sk', '_live_', 'c'.repeat(24)].join(''),
  jwt: ['ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjMiLCJleHAiOjE3MDAwMDAwMDB9', '.', 'sig_part_abcdefgh'].join(''),
  pem: ['-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf\n-----END ', 'RSA PRIVATE KEY-----'].join(''),
};

test('refang undoes common defanging', () => {
  assert.equal(S.refang('hxxps://evil[.]example[.]com/a hXXp[://]x[.]ru'), 'https://evil.example.com/a http://x.ru');
  assert.equal(S.refang('bad[@]corp[dot]com 10[.]0[.]0[.]1 fxp://f(.)io'), 'bad@corp.com 10.0.0.1 ftp://f.io');
});

test('defang makes indicators non-clickable and round-trips', () => {
  const src = 'Beacon to https://evil.example.com/path.php?a=1, mail ops@corp.io, ip 203.0.113.9 and c2.bad.ru.';
  const out = S.defang(src);
  assert.equal(out, 'Beacon to hxxps://evil[.]example[.]com/path.php?a=1, mail ops[@]corp[.]io, ip 203[.]0[.]113[.]9 and c2[.]bad[.]ru.');
  assert.equal(S.refang(out), src);
  assert.equal(S.defang('see README.md and setup.py, v1.2.3.4'), 'see README.md and setup.py, v1.2.3.4');
});

test('extractIocs finds and dedupes each type, including from defanged text', () => {
  const sha256 = 'a'.repeat(63) + 'b';
  const text = [
    'hxxps://evil[.]example[.]com/drop.exe (staging) and https://evil.example.com/drop.exe',
    'IPs 198.51.100.7, 198.51.100.7, 10.0.0.256 bad, fe80::1ff:fe23:4567:890a, time 12:30:45, mac 00:1a:2b:3c:4d:5e',
    'mail attacker[@]proton[.]me hash ' + 'd41d8cd98f00b204e9800998ecf8427e' + ' ' + 'da39a3ee5e6b4b0d3255bfef95601890afd80709' + ' ' + sha256,
    'cve-2024-3094 and CVE-2021-44228, technique T1059.001 and T1566',
    'files: notes.md run.sh app.js; version 1.2.3.4.5',
  ].join('\n');
  const r = S.extractIocs(text);
  assert.deepEqual(r.urls, ['https://evil.example.com/drop.exe']);
  assert.deepEqual(r.ipv4, ['198.51.100.7']);
  assert.deepEqual(r.ipv6, ['fe80::1ff:fe23:4567:890a']);
  assert.deepEqual(r.emails, ['attacker@proton.me']);
  assert.deepEqual(r.domains, ['evil.example.com', 'proton.me']);
  assert.deepEqual(r.md5, ['d41d8cd98f00b204e9800998ecf8427e']);
  assert.deepEqual(r.sha1, ['da39a3ee5e6b4b0d3255bfef95601890afd80709']);
  assert.deepEqual(r.sha256, [sha256]);
  assert.deepEqual(r.cves, ['CVE-2024-3094', 'CVE-2021-44228']);
  assert.deepEqual(r.attack, ['T1059.001', 'T1566']);
  assert.equal(S.iocCount(r), 13);
});

test('URL trimming drops trailing prose punctuation but keeps balanced brackets', () => {
  assert.deepEqual(S.extractIocs('(see https://x.example.com/a).').urls, ['https://x.example.com/a']);
  assert.deepEqual(S.extractIocs('https://en.wikipedia.org/wiki/Foo_(bar)').urls, ['https://en.wikipedia.org/wiki/Foo_(bar)']);
});

test('CSV export quotes and blocks spreadsheet formula injection', () => {
  assert.equal(S.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(S.csvCell('+cmd'), '"\'+cmd"');
  assert.equal(S.csvCell('plain'), 'plain');
  const csv = S.iocsToCsv(S.extractIocs('https://a.example.com 1.2.3.4'), { defanged: true });
  assert.equal(csv, 'type,value\r\nurls,hxxps://a[.]example[.]com\r\ndomains,a[.]example[.]com\r\nipv4,1[.]2[.]3[.]4');
});

test('iocsToMarkdown keeps values in code blocks', () => {
  const md = S.iocsToMarkdown(S.extractIocs('8.8.8.8'), { defanged: true, source: 'Case 7', when: '2026-11-23' });
  assert.match(md, /^# IOCs from Case 7/);
  assert.match(md, /## IPv4 addresses \(1\)\n```\n8\[\.\]8\[\.\]8\[\.\]8\n```/);
});

test('scanSecrets detects common credential formats', () => {
  const text = [
    `aws key ${fake.aws}`,
    `token: ${fake.github}`,
    fake.slack,
    fake.google,
    fake.stripe,
    `Authorization: Bearer ${fake.jwt}`,
    fake.pem,
    'db = postgres://admin:S3cretPass@db.internal:5432/app',
    'password = hunter2hunter2',
  ].join('\n');
  const ids = S.scanSecrets(text).map((f) => f.id);
  assert.deepEqual(ids, ['aws-access-key', 'github-token', 'slack-token', 'google-api-key', 'stripe-key', 'jwt', 'private-key', 'url-password', 'assignment']);
});

test('scanSecrets ignores placeholders and masks previews', () => {
  const none = S.scanSecrets('password = ******** \napi_key: <your-key>\ntoken=${TOKEN}\nsecret: [REDACTED:jwt]\npassword: changeme');
  assert.deepEqual(none, []);
  const [f] = S.scanSecrets(`key ${fake.aws}`);
  assert.equal(f.line, 1);
  assert.ok(!f.preview.includes(fake.aws.slice(4, 18)));
  assert.equal(f.preview.slice(0, 4), 'AKIA');
});

test('maskSecrets and scrubValues remove the values', () => {
  const text = `a ${fake.github} b password=hunter2hunter2`;
  const findings = S.scanSecrets(text);
  const masked = S.maskSecrets(text, findings);
  assert.equal(masked, 'a [REDACTED:github-token] b password=[REDACTED:assignment]');
  assert.deepEqual(S.scanSecrets(masked), []);
  assert.equal(S.scrubValues(`old ${fake.github} copy`, findings.map((f) => f.value)), 'old [REDACTED] copy');
});

test('decoders', () => {
  assert.equal(S.hexEncode('Hi ✓'), '486920e29c93');
  assert.equal(S.hexDecode('48 69 0x20 \\xe2\\x9c\\x93'), 'Hi ✓');
  assert.throws(() => S.hexDecode('abc'), S.SecOpsError);
  assert.throws(() => S.hexDecode('ff'), S.SecOpsError);
  assert.equal(S.htmlEncode('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(S.htmlDecode('&lt;b&gt; &#x41;&#66; &amp;amp; &bogus; &#0; &#xD800;'), '<b> AB &amp; &bogus; &#0; &#xD800;');
  assert.equal(S.rot13('Hello, World'), 'Uryyb, Jbeyq');
  assert.equal(S.rot13(S.rot13('round trip')), 'round trip');
});

test('decodeJwt decodes without verifying and flags expiry', () => {
  const r = S.decodeJwt(fake.jwt, Date.UTC(2026, 0, 1));
  assert.deepEqual(r.header, { alg: 'HS256' });
  assert.equal(r.payload.sub, '123');
  assert.equal(r.claims.exp, '2023-11-14T22:13:20.000Z');
  assert.equal(r.expired, true);
  assert.equal(r.signed, true);
  assert.equal(S.findJwt(`Bearer ${fake.jwt} trailing`), fake.jwt);
  assert.throws(() => S.decodeJwt('a.b'), S.SecOpsError);
  assert.throws(() => S.decodeJwt('eyJ!!!.eyJ.x'), S.SecOpsError);
  assert.throws(() => S.decodeJwt(['eyJub3Q', 'gzc29u', '.eyJhIjoxfQ.x'].join('')), S.SecOpsError);
});

test('convertTimestamp handles Unix, FILETIME and ISO', () => {
  assert.equal(S.convertTimestamp('1700000000').iso, '2023-11-14T22:13:20.000Z');
  assert.equal(S.convertTimestamp('1700000000123').iso, '2023-11-14T22:13:20.123Z');
  assert.equal(S.convertTimestamp('1700000000123456').kind, 'Unix microseconds');
  const ft = S.convertTimestamp('133444736000000000');
  assert.equal(ft.kind, 'Windows FILETIME / Active Directory');
  assert.equal(ft.iso, '2023-11-14T22:13:20.000Z');
  assert.equal(S.convertTimestamp('2023-11-14T22:13:20Z').unixSeconds, 1700000000);
  assert.equal(S.convertTimestamp('2023-11-14T22:13:20Z').filetime, 133444736000000000n);
  assert.throws(() => S.convertTimestamp('hello'), S.SecOpsError);
  assert.throws(() => S.convertTimestamp(''), S.SecOpsError);
});

test('hashText matches known SHA vectors', async () => {
  const h = await S.hashText('abc');
  assert.equal(h['SHA-1'], 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(h['SHA-256'], 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(h['SHA-512'].slice(0, 16), 'ddaf35a193617aba');
});

test('scanning is bounded on large input', () => {
  const big = 'password=abcdefgh '.repeat(50000);
  const t0 = Date.now();
  const r = S.scanSecrets(big);
  assert.ok(r.length <= S.MAX_FINDINGS);
  assert.ok(Date.now() - t0 < 3000);
});
