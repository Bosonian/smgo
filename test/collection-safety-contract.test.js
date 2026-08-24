'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { collectionIdForPath, createCollectionContext } = require('../collection-context');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('canonical hash IDs stay unique for readable-slug collisions', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = collectionIdForPath(`C:\\SuperMemo\\systems\\Same Name-${i}`);
    assert.equal(ids.has(id), false, `collision for ${id}`);
    ids.add(id);
  }
  assert.notEqual(
    collectionIdForPath('C:\\SuperMemo\\systems\\Same Name'),
    collectionIdForPath('C:\\Other\\Same Name')
  );
});

test('a forged environment ID is rejected instead of retargeting a collection', () => {
  assert.throws(() => createCollectionContext({
    collectionPath: 'C:\\SuperMemo\\systems\\Safe', collectionId: 'collection-forged-000000000000',
  }), /does not match/);
});

test('PWA, desktop bridge, and service worker retain fail-closed queue contracts', () => {
  const app = read('docs/app.js');
  const plugin = read('SMAPlugin/SMGoPlugin.cs');
  const sw = read('docs/sw.js');
  assert.match(app, /protocolVersion: payload\.protocolVersion \|\| PROTOCOL_VERSION/);
  assert.match(app, /commandId/);
  assert.match(app, /cannot be moved to another collection/);
  assert.match(plugin, /payload\["commandId"\].*id/);
  assert.match(plugin, /HasProtocolV2/);
  assert.match(plugin, /not fully applied/);
  assert.match(sw, /status: 503/);
});

test('migration is transactional and future bootstrap uses composite daily identity', () => {
  const sql = read('supabase-migration-collections.sql');
  assert.match(sql, /^begin;/m);
  assert.match(sql, /commit;\s*$/m);
  assert.match(sql, /primary key \(collection_id, review_date\)/i);
  assert.match(sql, /create or replace function public\.smgo_setup/i);
});

test('legacy highlight state is opt-in and one-time', () => {
  const source = read('highlight-extract.js');
  assert.match(source, /--import-legacy-highlight-state/);
  assert.match(source, /legacy highlight state exists/);
  assert.match(source, /__smgoLegacyImport/);
});
