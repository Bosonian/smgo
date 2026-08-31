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

## PWA experience

The header always identifies the active collection and provides an explicit
queue refresh. A zero-card export is a healthy connected state: the PWA shows
the collection name and export time instead of treating an empty day as an
error or completed review session.

Settings are stored only in that browser and can be managed from the Settings
sheet. The Supabase connection can be tested before saving. Initial cloud,
static, and LAN queue loads time out instead of leaving the app on an infinite
spinner.

The **Saved actions** drawer includes extracts, clozes, Q&A items, and notes.
Each record is marked Pending or Synced. **Remove synced** only removes records
already delivered; removing an unsynced record requires separate confirmation.
Offline actions remain collection-scoped in local storage and retry when the
app comes online or returns to the foreground.

The PWA supports keyboard focus, Escape-to-close, focus containment in dialogs,
screen-reader status announcements, safe-area insets, and reduced-motion
preferences. Loading, empty, and error states leave the header accessible so
Refresh and Settings are always reachable.

## Validation

Run `npm test` for collection-context regression coverage, and `npm run start`
with `config.json` configured for a manual LAN server. Build the plugin with
`SMAPlugin/build.bat` after installing the SuperMemo Assistant dependencies.

For a PWA release, increment the cache name in `docs/sw.js`; installed clients
otherwise continue using the previous cached shell. The current shell cache is
`smgo-v51`.

## Current limitations

- Automatic grade application through SMA is not currently reliable because the
  running remoting service does not implement the advertised `AssignGrade`
  method. Grade commands remain pending and do not block extracts, Q&A, cloze,
  dismiss, or priority commands.
- Automatic dismissal is also unavailable in this SMA/SM18 runtime. Dismiss
  commands remain pending; SMGo deliberately does not rewrite live SuperMemo
  queue files or send unverified keystrokes.
- An outstanding ID with no corresponding SuperMemo element file is omitted
  rather than exported as an empty card.
- SuperMemo's `[...]` markers are incremental-reading extraction gaps already
  present in the source Topic; they are not PWA text truncation.

SMGo-created Q&A and cloze Items carry explicit encoded metadata on their
question component. Do not infer question/answer relationships from adjacent
element IDs. After a cloud mutation batch, the plugin performs one consolidated
re-export so newly created Items and dismissals reach the PWA in the same
SM/SMA session.
