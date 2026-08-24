'use strict';

// One deliberately small collection contract shared by the Node utilities.
// The SMA plugin supplies these values for the collection currently open in
// SuperMemo. Manual runs can use config.json instead (see config.example.json).
const path = require('path');
const crypto = require('crypto');

function canonicalizeCollectionPath(collectionPath) {
  if (!collectionPath) throw new Error('SMGo collection path is required');
  // SuperMemo collections are Windows paths even when tests run elsewhere.
  let canonical = path.win32.resolve(String(collectionPath).normalize('NFC'))
    .replace(/\//g, '\\')
    .toLowerCase();
  // Keep a drive root intact while making normal trailing separators irrelevant.
  if (!/^[a-z]:\\$/i.test(canonical)) canonical = canonical.replace(/\\+$/, '');
  return canonical;
}

function readableSlug(value) {
  const folded = String(value || '')
    .normalize('NFKD')
    // Keep this aligned with C# UnicodeCategory.NonSpacingMark, including
    // marks outside the Latin U+0300 block (for example U+0483).
    .replace(/\p{Mn}/gu, '')
    .toLowerCase();
  return folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'collection';
}

function collectionIdForPath(collectionPath) {
  const canonical = canonicalizeCollectionPath(collectionPath);
  const slug = readableSlug(path.win32.basename(canonical));
  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
  return `collection-${slug}-${hash}`;
}

function optionValue(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function createCollectionContext({ collectionPath, collectionId, collectionName } = {}) {
  if (!collectionPath) {
    throw new Error(
      'SMGo needs a collection path. Open a collection through the SMA plugin, ' +
      'or set collection.path in config.json.'
    );
  }
  const canonicalPath = canonicalizeCollectionPath(collectionPath);
  const id = collectionIdForPath(canonicalPath);
  if (collectionId && collectionId !== id) {
    throw new Error('SMGo collection ID does not match the canonical collection path');
  }
  return {
    id,
    name: collectionName || path.win32.basename(canonicalPath),
    path: canonicalPath,
    elementsDir: path.win32.join(canonicalPath, 'elements'),
    infoDir: path.win32.join(canonicalPath, 'info'),
  };
}

function loadCollectionContext(config = {}, env = process.env, argv = process.argv.slice(2)) {
  const configured = config.collection || {};
  const environmentPath = env.SMGO_COLLECTION_PATH || optionValue(argv, '--collection-path');
  return createCollectionContext({
    collectionPath: environmentPath || configured.path || config.collectionPath,
    collectionId: env.SMGO_COLLECTION_ID || optionValue(argv, '--collection-id') ||
      (environmentPath ? undefined : configured.id || config.collectionId),
    collectionName: env.SMGO_COLLECTION_NAME || optionValue(argv, '--collection-name') ||
      configured.name || config.collectionName,
  });
}

module.exports = {
  canonicalizeCollectionPath, readableSlug, collectionIdForPath,
  createCollectionContext, loadCollectionContext,
};
