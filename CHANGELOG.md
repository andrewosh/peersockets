# CHANGELOG

# 1.0.0
Updated the API to reflect the swarm-wide extensions that were added in `@corestore/networker@1.0.0`. This update also removed
the `listPeers` and `watchPeers` methods, which can be implemented directly using the networker's `peer-add` and `peer-remove` events.

- Remove `listPeers` and `watchPeers`
- `send` and `onmessage` are passed `Peer` objects instead of NOISE keys. `Peer` objects are emitted from `@corestore/networker`'s `peer-add` and `peer-remove` events.
- The parameters have been reordered in `send` and `onmessage` to match `@corestore/networker`'s extensions. `onmessage(noiseKey, message)` and `send(noiseKey, message)` have been changed to `onmessage(message, peer)` and `send(message, peer)`.
