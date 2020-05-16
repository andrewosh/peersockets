const { EventEmitter } = require('events')

class TopicHandle {
  constructor (topic, opts = {}) {
    this._topic = topic
    this.onmessage = opts.onmessage
    this.onclose = opts.onclose
  }
  close () {
    this._topic.closeHandle(this)
  }
  send (remoteKey, msg) {
    if (Buffer.isBuffer(remoteKey)) remoteKey = remoteKey.toString('hex')
    this._topic.send(remoteKey, msg)
  }
}

class Topic extends EventEmitter {
  constructor (name) {
    super()
    this.name = name
    this._extensions = new Map()
    this._handles = []
  }

  registerExtension (stream) {
    const remoteKey = stream.remotePublicKey
    const keyString = remoteKey.toString('hex')
    const handlers = {
      onmessage: (msg) => {
        for (const handle of this._handles) {
          if (handle.onmessage) handle.onmessage(remoteKey, msg)
        }
      },
      onerror: (err) => {
        this.emit('topic-error', err, remoteKey)
      }
    }
    const extension = stream.registerExtension(Peersockets.EXTENSION_PREFIX + this.name, handlers)
    this._extensions.set(keyString, extension)
    return extension
  }

  removeExtension (remoteKey) {
    const extension = this._extensions.get(remoteKey)
    if (!extension) return
    extension.destroy()
    this._extensions.delete(remoteKey)
  }

  createHandle (opts = {}) {
    const handle = new TopicHandle(this, opts)
    this._handles.push(handle)
    return handle
  }

  closeHandle (handle) {
    if (this._handles.indexOf(handle) === -1) return
    this._handles.splice(this._handles.indexOf(handle), 1)
  }

  send (remoteKey, msg) {
    const extension = this._extensions.get(remoteKey)
    if (!extension) throw new Error('Topic extension not registered for peer.')
    extension.send(msg)
  }

  close () {
    for (const [remoteKey, extension] of this._extensions) {
      extension.destroy()
    }
    for (const handle of this._handles) {
      if (handle.onclose) handle.onclose(null)
    }
  }
}

class Peersockets extends EventEmitter {
  constructor (networker) {
    super()
    this.networker = networker
    this.corestore = networker.corestore

    this.topicsByName = new Map()
    this.streamsByKey = new Map()

    this._joinListener = this._onjoin.bind(this)
    this._leaveListener = this._onleave.bind(this)
    this.networker.on('handshake', this._joinListener)
    this.networker.on('stream-closed', this._leaveListener)
  }

  _onjoin (stream, info) {
    const remoteKey = stream.remotePublicKey
    const keyString = remoteKey.toString('hex')
    this.streamsByKey.set(keyString, stream)
    // Register all topic extensions on the new stream
    for (const [, topic] of this.topicsByName) {
      topic.registerExtension(stream)
    }
  }

  _onleave (stream, info, finishedHandshake) {
    if (!finishedHandshake || (info && info.duplicate)) return
    // If the stream never made it through the handshake. abort.
    const keyString = stream.remotePublicKey.toString('hex')
    for (const [, topic] of this.topicsByName) {
      topic.removeExtension(keyString)
    }
  }

  join (topicName, opts) {
    let topic = this.topicsByName.get(topicName)
    if (topic) return topic.createHandle(opts)
    topic = new Topic(topicName)
    this.topicsByName.set(topicName, topic)
    // Register the topic extension on all streams.
    for (const [,stream] of this.streamsByKey) {
      topic.registerExtension(stream)
    }
    return topic.createHandle(opts)
  }

  leave (topicName) {
    const topic = this.topicsByName.get(topicName)
    if (!topic) return
    // Close the topic (this destroys every stream's per-topic extension)
    topic.close()
    this.topicsByName.delete(topicName)
  }

  stop () {
    if (!this._joinListener) return
    this.networker.removeListener('handshake', this._joinListener)
    this.networker.removeListener('stream-closed', this._leaveListener)
    this._joinListener = null
    this._leaveListener = null
  }

  listPeers (discoveryKey) {
    if (!discoveryKey) {
      return this.networker.streams.map(stream => peerInfo(stream))
    }
    const core = this.corestore.get({ discoveryKey })
    return core.peers.map(peerInfo)

    function peerInfo (stream) {
      return {
        key: stream.remotePublicKey,
        address: stream.remoteAddress,
        type: stream.remoteType
      }
    }
  }

  watchPeers (discoveryKey, opts = {}) {
    const core = this.corestore.get({ discoveryKey })
    const watcher = new EventEmitter()
    const peerCounts = new Map()
    const firstPeers = this.listPeers(discoveryKey) || []
    if (firstPeers) {
      for (const { key: remoteKey } of firstPeers) {
        peerCounts.set(remoteKey.toString('hex', 1))
        opts.onjoin(remoteKey)
      }
    }
    const joinedListener = (peer) => {
      const remoteKey = peer.remotePublicKey
      updateMap(peerCounts, remoteKey.toString('hex'), old => {
        const updated = ++old
        if (updated === 1) opts.onjoin(remoteKey)
        return updated
      }, 0)
    }
    const leftListener = (peer) => {
      // TODO: This should be public.
      if (!peer._remoteOpened) return
      const remoteKey = peer.remotePublicKey
      updateMap(peerCounts, remoteKey.toString('hex'), old => {
        const updated = --old
        if (!updated) opts.onleave(remoteKey)
        return updated
      } , 0)
    }
    const close = () => {
      core.removeListener('peer-open', joinedListener)
      core.removeListener('peer-remove', leftListener)
    }
    if (opts.onjoin) core.on('peer-open', joinedListener)
    if (opts.onleave) core.on('peer-remove', leftListener)
    return close
  }
}
Peersockets.EXTENSION_PREFIX = 'peersockets/v0/'

function upsert (map, key, createFn) {
  if (map.has(key)) return map.get(key)
  let value = createFn()
  map.set(key, value)
  return value
}

function updateMap (map, key, updateFn, defaultValue) {
  map.set(key, updateFn(map.get(key) || defaultValue))
}

module.exports = Peersockets
