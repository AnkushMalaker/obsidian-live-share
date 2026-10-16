# Canvas sync regression testing

## Reproduction on v0.6.0

1. Connect two Obsidian vaults to the same Live Share session.
2. Create an empty canvas in the shared folder and open it on both devices.
3. From the same empty view, add a linked-note card on one device and a text card on the other before the remote disk/view refresh completes.
4. Wait for synchronization. Both cards should remain. On v0.6.0, a stale full-file save can remove the other participant's new card.

Editing the Markdown note inside a file card is a separate operation. That can work while changes to the canvas graph fail. A single editor adding a card to a fresh canvas can also work, so that alone does not reproduce the race.

## Automated coverage

```sh
cd plugin
npm ci
npm test -- src/__tests__/canvas-regression.test.ts
npm run lint
npm run build
npm test
```

The regression tests exercise session/file routing with the actual Canvas and background sync classes. Independent Y.Docs cover stale local snapshots and concurrent updates. Coverage includes linked cards, edges, independent property edits, extra Canvas metadata, empty boards, partial JSON saves, guest-created boards, renames, removal, delayed initial seeding, and edits immediately after remote writes.

The initial eight regression tests were run against untouched v0.6.0 and failed before the fix. The reported live race was also reproduced between two Macs before installation: only the second participant's card survived.

## Local plugin installation

After `npm run build`, copy `plugin/main.js`, `plugin/styles.css`, and the root `manifest.json` into the test vault's `.obsidian/plugins/live-share/` directory. Back up the vault and its existing plugin first. Use the same fork build on all participants.

Reload the plugin through Obsidian's community plugin settings or its CLI. Reloading v0.6.0 can end the existing session; start a new session and join it again if necessary.

## Live smoke checks

Use disposable canvases rather than changing an existing board:

- Repeat the stale-view reproduction and verify both cards remain on both devices.
- Add a linked-note card through the Canvas UI and verify the other open Canvas view updates without reopening it.
- Add and remove an edge in both directions.
- Move a card on one device while resizing it on the other; both changes should remain.
- Create a canvas on the joining device, then rename it and continue editing it.
- Delete a test canvas and confirm it does not reappear from a queued write.
- Briefly reconnect the sync channel and confirm a local edit survives and both copies converge.
- Verify that extra root metadata and the original node ordering are preserved.

The relay API and deployment do not change for this fix. Canvas files use the existing `__canvas__:` document namespace; they are excluded from the ordinary text-document writer.

## Plain text card overwrite regression

The first Canvas fix (`d07cd62`) scheduled a write after a local save and compared
the resulting JSON as bytes. Obsidian and Live Share serialize the same graph
with different formatting and key order, so Live Share wrote the unchanged graph
back to disk. That external write could reload a card containing newer text.

Reproduce with a disposable text card open on two clients:

1. Change its text to `Hi, my name is `.
2. After about 2.6 seconds, append `John.`. Canvas has separate debounced saves
   for the text editor and the board, so the prefix reaches disk first.
3. At about five seconds, the redundant Live Share write restores the prefix,
   removing `John.` from the still-open editor.

The fix compares parsed Canvas data, ignoring whitespace and object-key order
while preserving array order. Equivalent graphs cause no disk write. Actual
merged changes still propagate. The automated regression models an unsaved
editor being reloaded by an external adapter write and confirms that the next
save reaches the other client. A second case covers formatting/key-order changes
during initial hydration.

Live verification on the two Macs reproduced the disappearing suffix before
the fix. With the fixed build installed on both, the same 2.6-second typing
sequence passed in both directions for plain cards and embedded Markdown notes.
The suffix remained in the editor and the complete text reached both clients.

This does not change plain card text from a whole-string Y.Map property into a
character-level Y.Text. Simultaneous edits to the same card's text remain a
separate collaboration limitation.

## Pending movement overwritten by another card's move

The earlier tests merged changes that had already reached disk. A Canvas view
can hold a visible move for two seconds before saving it. The following live
sequence reproduced a rollback on `4539d7c`:

1. Start with two cards at x=0 and x=300, open on both Macs.
2. Move the first card to x=100 on the host.
3. About 2.1 seconds later, move the second card to x=500 on the guest.
4. The host's update reaches the guest before its local save. The external disk
   write restores the second card to x=300; both clients eventually agree on the
   wrong position.

`CanvasWorkspace` now flushes pending text-card buffers and board saves before
an incoming write. It supplies each dirty view's own saved baseline, so their
independent deltas merge into Yjs before disk/view refresh. Incoming writes defer
while a save is in flight or a view becomes dirty during asynchronous work. A
fresh disk read also captures saves whose vault event has not completed, and the
outgoing graph is serialized after those reads. Superseded local reads cannot
publish an older snapshot over a newer merged write.

Eight additional regression tests cover unsaved moves, two dirty views of one
board, an in-flight save, edits during a disk read, an unprocessed local save,
remote updates during a disk read, pending text buffers, and a late stale read.
Live movement checks on both Macs cover the exact failing timing in both
directions, simultaneous moves to different cards, and repeated moves during an
incoming update. Typing a delayed suffix while a different card moves remotely
also passes in both directions, preserving both the text and the new position.

The temporary diagnostic trace records test-card IDs, coordinates, save timing,
and shared state. It does not record note contents. Live Share debug logging was
disabled, so it did not provide a historical recording of the user's preceding
actions. Temporary tracing is removed after reproduction.
