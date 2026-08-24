# SMGo

SMGo exports the daily queue from the SuperMemo collection currently open in
SuperMemo Assistant and makes it available to the mobile PWA. Grades, edits,
extracts, priorities, and dismissals are returned through a collection-scoped
queue.

## Start a new collection safely

1. Create/open the new collection in SuperMemo. The SMA plugin reads its root
   path from SuperMemo automatically; do not edit source files for a collection
   name or path.
2. Run `supabase-migration-collections.sql` once in the Supabase SQL editor.
   It keeps old rows under `legacy-facharzt` and prevents them from being
   applied to your new collection.
3. Copy `config.example.json` to the ignored `config.json` and enter only your
   Supabase URL/key. `collection.path` is needed for manual Node commands;
   when the plugin launches them it supplies the live collection itself.
4. Build/install the SMA plugin, open the new collection, then wait for the
   automatic export. In the PWA, choose the collection from the header when
   more than one collection has a queue for today.
5. If you use Syncthing/Xodo PDF annotations, update the `sm-elements` folder
   to the new collection's `elements` directory before scanning highlights.
   The highlight script receives the same active collection context from the
   plugin; its saved scan state is also separated by collection. A Task Scheduler
   run is manual-context mode, so `config.json` must contain that collection path.
   If migrating the old Facharzt highlight cache, run once with
   `--import-legacy-highlight-state`; it deliberately refuses an implicit import.

The collection ID is deterministically derived from the normalized collection
path. Every cloud command, local queue item, and browser-local pending action
includes that ID. The plugin filters cloud commands by it and checks the
payload again before mutating SuperMemo.

## Local queues

New LAN fallback files live in:

```text
queues/<collection-id>/grades
queues/<collection-id>/extracts
queues/<collection-id>/items
queues/<collection-id>/dismisses
```

Older unscoped `grades/` and `extracts/` folders are intentionally not replayed
by the plugin. Review/archive them manually; never copy their contents to a
new collection unless you have confirmed every element ID belongs there.

The old `GradeApplicator` batch tools are legacy/manual utilities. They do not
know the active SMA collection and are not a safe replacement for the plugin's
collection-checked queue processor.

## Validation

Run `npm test` for collection-context regression coverage, and `npm run start`
with `config.json` configured for a manual LAN server. Build the plugin with
`SMAPlugin/build.bat` after installing the SuperMemo Assistant dependencies.
