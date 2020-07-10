## `peersockets` v1.0.0
With 1.0, the internal design has been updated to use `@corestore/networker`'s stream-level extensions. Similarly, the external APIs have been altered to use the patterns defined there.
* `onmessage(remoteKey, message)` has been changed to `onmessage(message, peer)`, where peer is a `@corestore/networker` Peer object.
* `topic.send(remoteKey, message)` has been changed to `topic.send(message, peer).
