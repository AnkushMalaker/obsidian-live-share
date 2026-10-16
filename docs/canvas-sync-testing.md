# Canvas synchronization and validation

Canvas files use a dedicated Yjs document (`__canvas__:<path>`) with per-card and
per-edge maps. The ordinary text synchronizer does not write Canvas JSON.

Local changes are compared with their previous local snapshot. This preserves
independent remote additions, moves, connections, and property edits. Root
metadata and item ordering are retained. Invalid or duplicate-ID JSON is ignored
rather than treated as an empty board.

An incoming write captures all dirty Canvas leaves before any disk modification.
Pending text-card buffers are flushed into their card models. Their deltas enter
Yjs together; the merged graph is then applied to the leaves and written once.
Open leaves supply native serialization, checked against the shared graph. The
persisted bytes match native save baselines so queued unchanged autosaves skip
their writes. A failed write restores the previous native baseline and requests
a save of the current graph.
The adapter does not save each leaf individually, because a native save can
reload its siblings. A save already in flight or a new edit during asynchronous
work postpones the incoming write. Disk reads are associated with their starting
baseline and local-read generation; changed generations trigger a fresh read.
Completed native saves are also detected through each captured view baseline. Yjs observers
are attached before initial hydration.

A fresh host subscription uses its local Canvas as authoritative, matching the
upstream host-vault policy. This preserves edits made while the plugin was
unloaded. It is not a three-way offline merge: conflicting changes made only on a
retained guest may be replaced by the host. A board announced as newly created
by another participant is hydrated from that participant instead. A normal
socket reconnect retains the existing local baseline.

Plain card text remains a whole-string Y.Map property. Character-level concurrent
editing of the same plain card is not implemented. Markdown note documents use
Y.Text; this change does not add CodeMirror bindings to embedded note editors.

## Automated checks

```sh
cd plugin
npm ci
npm test
npm run lint
npm run build
```

`canvas-regression.test.ts` covers Canvas routing and graph operations with
independent Y.Docs. `canvas-audit.test.ts` covers delayed reads/writes, fresh host
resume, sibling-view reloads, initial hydration, and native autosaves during a
write. `canvas-native-ordering.test.ts` adds delayed modify-handler reads and
queued autosaves with a newer sibling edit. `canvas-format-and-view.test.ts`
covers empty/optional arrays, pending-write reversals, and write failures.
The shared fixture destroys released documents and models sibling reloads
on saves. These are controlled unit tests, not a complete Obsidian/relay
integration environment. They do not by themselves establish encryption,
permissions, guest rename, or all filesystem-watcher orderings.

## Native checks

Use disposable canvases and the same built plugin on both participants. Record
the build hash, Obsidian versions, and results with each tested build.

- Add linked cards and connections; verify the other open view updates.
- Move different cards from each device, including when the second move occurs
  about 2.1 seconds after the first and has not reached disk yet.
- Type a prefix in a plain card, then append a word about 2.6 seconds later. Check
  that it remains visible and reaches the other device.
- Type while a different card moves remotely.
- Open two leaves of one board and stage independent unsaved changes. Verify both
  survive an incoming change and a native sibling reload.
- Check guest-created boards, rename, deletion, and rejoining a session.

Earlier build-specific traces are stored with local build artifacts. Their
results apply to those exact builds; rerun the relevant cases after changing
save/reload behavior. Temporary diagnostics should record only disposable test
content and be removed when testing finishes.

## Folder inventory regression

Directory entries in the manifest describe empty folders. Retiring a marker when
saving its first child, receiving a late folder-create message, or republishing
an inventory must not trash or rename a physical folder. Intentional folder
operations use explicit file-operation messages. `folder-marker-loss.test.ts`
exercises the real manifest manager and plugin callback, including a two-document
peer update, inventory refresh, and folder rename collisions.

Local diagnostics can be enabled in plugin settings. Use
`.obsidian/plugins/live-share/debug.log` to keep the log out of shared notes.
The log identifies the client and records inventory changes, outgoing/incoming
folder operations, and observed local deletes. It records paths and operation
metadata rather than note bodies or connection secrets. A vault delete event
identifies the observing client; it cannot identify the originating OS process.
