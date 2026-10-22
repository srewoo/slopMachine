import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSitePattern, siteMatches } from '../src/shared/sites.ts';
import { DEFAULT_SETTINGS, parseSettings } from '../src/shared/settings.ts';

test('accepts domains, subdomains and wildcards in the forms people paste', () => {
  const cases: [string, string][] = [
    ['mindtickle.com', 'https://mindtickle.com'],
    ['help.mindtickle.com', 'https://help.mindtickle.com'],
    ['*.mindtickle.com', 'https://*.mindtickle.com'],
    ['https://*.mindtickle.com/', 'https://*.mindtickle.com'],
    ['  HTTPS://Help.MindTickle.com:8443/docs?q=1 ', 'https://help.mindtickle.com'],
    ['*.co.uk.example.org', 'https://*.co.uk.example.org'],
    ['bücher.de', 'https://xn--bcher-kva.de'],
  ];
  for (const [input, want] of cases) assert.equal(parseSitePattern(input), want, input);
});

test('rejects plain http, bare wildcards, TLD wildcards and junk', () => {
  for (const bad of ['http://example.com', '*', '*.com', 'https://*', 'ex*ample.com', 'a.*.example.com', '', 'localhost', 'ftp://x.com']) {
    assert.equal(parseSitePattern(bad), null, bad);
  }
});

test('wildcard covers the domain and every subdomain, exact host covers only itself', () => {
  assert.ok(siteMatches('https://*.mindtickle.com', 'mindtickle.com'));
  assert.ok(siteMatches('https://*.mindtickle.com', 'help.mindtickle.com'));
  assert.ok(siteMatches('https://*.mindtickle.com', 'a.b.mindtickle.com'));
  assert.ok(!siteMatches('https://*.mindtickle.com', 'evilmindtickle.com'));
  assert.ok(siteMatches('https://help.mindtickle.com', 'help.mindtickle.com'));
  assert.ok(!siteMatches('https://help.mindtickle.com', 'docs.mindtickle.com'));
});

test('settings accept wildcard entries and keep existing exact ones valid', () => {
  assert.ok(parseSettings({ ...DEFAULT_SETTINGS, genericOrigins: ['https://www.google.com', 'https://*.mindtickle.com'] }));
  assert.equal(parseSettings({ ...DEFAULT_SETTINGS, genericOrigins: ['https://*.com'] }), null);
});
