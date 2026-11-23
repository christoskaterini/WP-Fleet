import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertAssetType,
  assertDomainFormat,
  assertHestiaUser,
  assertSlug,
  assertZipFilename,
} from '../lib/validate.js';
import { spawnWpRaw } from '../lib/wpcli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

test('assertSlug blocks injection and path traversal', () => {
  assert.equal(assertSlug('classic-editor'), 'classic-editor');
  assert.equal(assertSlug('my_plugin_1'), 'my_plugin_1');
  for (const bad of ['../etc', 'a;id', 'a&&id', 'a|id', '$(whoami)', '`id`', 'a b', '']) {
    assert.throws(() => assertSlug(bad), /Invalid slug/);
  }
});

test('assertDomainFormat blocks invalid hostnames and traversal', () => {
  assert.equal(assertDomainFormat('Flexx.GR'), 'flexx.gr');
  assert.equal(assertDomainFormat('staging.shop.local'), 'staging.shop.local');
  for (const bad of ['../etc', 'a.com;id', 'http://a.com', '-bad.com', '']) {
    assert.throws(() => assertDomainFormat(bad), /Invalid domain/);
  }
});

test('assertHestiaUser blocks root and malformed usernames', () => {
  assert.equal(assertHestiaUser('flexx'), 'flexx');
  assert.equal(assertHestiaUser('shop_user1'), 'shop_user1');
  for (const bad of ['root', '1user', 'user;id', '../root', 'UPPER', '']) {
    assert.throws(() => assertHestiaUser(bad), /Invalid user/);
  }
});

test('assertZipFilename blocks path traversal and non-zip files', () => {
  assert.equal(assertZipFilename('bricks-1.12.4.zip'), 'bricks-1.12.4.zip');
  for (const bad of ['../evil.zip', 'dir/evil.zip', 'shell.php', 'a.zip.php', 'a;b.zip', '']) {
    assert.throws(() => assertZipFilename(bad), /Invalid ZIP filename/);
  }
});

test('assertAssetType only allows plugin or theme', () => {
  assert.equal(assertAssetType('plugin'), 'plugin');
  assert.equal(assertAssetType('theme'), 'theme');
  assert.throws(() => assertAssetType('core'), /Invalid asset type/);
  assert.throws(() => assertAssetType('mu-plugin'), /Invalid asset type/);
});

test('WP-CLI wrapper blocks dangerous subcommands and flags', () => {
  const site = { user: 'testuser', domain: 'testsite.local', path: '/home/testuser/web/testsite.local/public_html' };
  for (const badArgs of [
    ['eval', 'system("id");'],
    ['eval-file', '/tmp/x.php'],
    ['shell'],
    ['db', 'cli'],
    ['plugin', 'list', '--exec=system("id")'],
    ['plugin', 'list', '--require=/tmp/evil.php'],
  ]) {
    assert.throws(() => spawnWpRaw(site, badArgs), /Disallowed WP-CLI/);
  }
});

test('No shell:true anywhere in codebase', () => {
  for (const rel of ['server.js', 'lib/wpcli.js', 'lib/backup.js']) {
    const src = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    assert.equal(/shell\s*:\s*true/.test(src), false, `${rel} must not use shell: true`);
  }
});

test('robots.txt disallows all crawlers', () => {
  const txt = fs.readFileSync(path.join(rootDir, 'public', 'robots.txt'), 'utf8');
  assert.match(txt, /User-agent:\s*\*/);
  assert.match(txt, /Disallow:\s*\//);
});
