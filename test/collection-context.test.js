'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canonicalizeCollectionPath,
  collectionIdForPath,
  createCollectionContext,
  loadCollectionContext,
} = require('../collection-context');
const fixtures = require('./collection-id-fixtures.json');

test('collection ID fixtures define the JS/C# parity contract', () => {
  for (const fixture of fixtures) {
    assert.equal(collectionIdForPath(fixture.path), fixture.id);
    if (fixture.sameAs) assert.equal(collectionIdForPath(fixture.sameAs), fixture.id);
  }
});

test('readable slugs do not replace the canonical path hash', () => {
  const accent = collectionIdForPath('C:\\SuperMemo\\systems\\Fächer');
  const ascii = collectionIdForPath('C:\\SuperMemo\\systems\\Facher');
  assert.match(accent, /^collection-facher-[a-f0-9]{12}$/);
  assert.notEqual(accent, ascii);
  assert.equal(canonicalizeCollectionPath('C:/SuperMemo/systems/New Collection/'),
    'c:\\supermemo\\systems\\new collection');
});

test('environment context takes precedence over config', () => {
  const context = loadCollectionContext(
    { collection: { path: 'C:\\ignored', id: 'ignored' } },
    { SMGO_COLLECTION_PATH: 'C:\\SuperMemo\\systems\\Current', SMGO_COLLECTION_NAME: 'Current' },
    []
  );
  assert.equal(context.name, 'Current');
  assert.equal(context.id, collectionIdForPath('C:\\SuperMemo\\systems\\Current'));
});

test('a supplied collection ID must match the canonical path', () => {
  assert.throws(() => createCollectionContext({
    collectionPath: 'C:\\SuperMemo\\systems\\New Collection',
    collectionId: 'my-new-collection',
  }), /does not match/);
});

test('missing collection path fails closed', () => {
  assert.throws(() => createCollectionContext({}), /needs a collection path/);
});
