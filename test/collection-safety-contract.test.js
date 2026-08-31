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

test('PWA polish keeps saved actions visible, refreshable, and fail-safe', () => {
  const app = read('docs/app.js');
  const html = read('docs/index.html');
  const css = read('docs/style.css');
  const sw = read('docs/sw.js');
  assert.match(app, /fetchWithTimeout/);
  assert.match(app, /pendingEdits\.map/);
  assert.match(app, /Remove this unsynced action/);
  assert.match(app, /showEmptyCollection/);
  assert.match(html, /id="settings-modal"[^>]+role="dialog"/);
  assert.match(html, /id="refresh-btn"/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(sw, /icons\/icon-180\.png/);
});

test('ordinary adjacent topics are never guessed to be a Q&A pair', () => {
  const parser = read('sm-parser.js');
  assert.doesNotMatch(parser, /endsWith\('\?'\)/);
  assert.doesNotMatch(parser, /answerPairId\s*=\s*answer\.id/);
  assert.match(parser, /Do not infer Q&A relationships from adjacent element IDs/);
});

test('exports omit PDF wrappers that have no reviewable page text', () => {
  const localExport = read('export.js');
  const cloudExport = read('export-cloud.js');
  assert.match(localExport, /c\.type !== 'pdf-extract' \|\| Boolean\(c\.body\?\.trim\(\)\)/);
  assert.match(cloudExport, /c\.type !== 'pdf-extract' \|\| Boolean\(c\.body\?\.trim\(\)\)/);
});

test('Q&A and cloze Items use explicit metadata and never adjacency', () => {
  const plugin = read('SMAPlugin/SMGoPlugin.cs');
  const parser = read('sm-parser.js');
  const app = read('docs/app.js');
  assert.match(plugin, /data-smgo-answer-b64/);
  assert.match(plugin, /data-smgo-sentence-b64/);
  assert.match(parser, /function parseSmgoItem/);
  assert.match(parser, /type: 'qa'/);
  assert.match(app, /clozeSentence\.replace\(\/\\\[\(\[\^\\\]\]\+\)\\\]\/g/);
});

test('explicit Q&A and cloze metadata round-trips Unicode text', () => {
  const { _test } = require('../sm-parser');
  const answer = 'Überprüfung: β-blocker';
  const sentence = 'Die [Liquordrainage] senkt den Hirndruck.';
  const b64 = value => Buffer.from(value, 'utf8').toString('base64');
  assert.deepEqual(
    _test.parseSmgoItem(`<span data-smgo-type="qa" data-smgo-answer-b64="${b64(answer)}">Q?</span>`),
    { type: 'qa', answer }
  );
  assert.deepEqual(
    _test.parseSmgoItem(`<span data-smgo-type="cloze" data-smgo-sentence-b64="${b64(sentence)}">Q</span>`),
    { type: 'cloze', sentence }
  );
});

test('successful cloud mutations trigger one same-session re-export', () => {
  const plugin = read('SMAPlugin/SMGoPlugin.cs');
  assert.match(plugin, /bool collectionChanged = false/);
  assert.match(plugin, /collectionChanged = true/);
  assert.match(plugin, /if \(collectionChanged && IsCurrent\(context\)\) RunExportCloud\(\)/);
});

test('unsupported SMA grade and dismiss calls fail closed', () => {
  const plugin = read('SMAPlugin/SMGoPlugin.cs');
  assert.match(plugin, /IsUnavailableInteropMethod/);
  assert.match(plugin, /left grade pending because this SMA\/SM build cannot verify grading/);
  assert.match(plugin, /left dismiss pending because this SMA\/SM build cannot dismiss/);
  assert.doesNotMatch(plugin, /SendKeys\.SendWait/);
  assert.doesNotMatch(plugin, /RemoveDismissedElementFromQueues/);
});

test('cloud commands are ordered, durable, and cannot be resurrected', () => {
  const plugin = read('SMAPlugin/SMGoPlugin.cs');
  const app = read('docs/app.js');
  assert.match(plugin, /orderedItems\.Sort/);
  assert.match(plugin, /case "dismiss": return 3/);
  assert.match(plugin, /data-smgo-command-b64/);
  assert.match(plugin, /AlreadyMaterialized\(p, context\)/);
  assert.match(plugin, /if \(response\.IsSuccessStatusCode\) return true/);
  assert.match(app, /resolution=ignore-duplicates,return=minimal/);
  assert.match(app, /applied: false/);
});
