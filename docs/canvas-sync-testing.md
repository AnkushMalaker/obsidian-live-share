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
