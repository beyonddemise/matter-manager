# End-to-end tests

Playwright. **Created in M2**, once there is a UI to drive.

## What belongs here

Journeys that cross layers and cannot be verified any other way:

- Scan a code, file a device, find it in the list
- Generate a PDF and assert its contents
- **Offline behaviour** via `context.setOffline(true)`: create devices with no connectivity,
  reconnect, confirm they sync
- **Conflict behaviour**: two browser contexts edit the same device offline, both reconnect,
  and both remarks survive

## What does not

Payload decoding, validation rules and merge logic. Those are pure functions in `core`,
where hundreds of cases run in milliseconds. Testing them through a browser would be slow,
flaky, and would cover a fraction of the input space.

## Camera

Not driven directly. The scan path is exercised through manual payload entry; the decoding
itself is covered exhaustively by `core` unit tests. Automating a real camera would test
Playwright's fake-video-device support rather than this application.
