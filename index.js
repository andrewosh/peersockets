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
    const remoteKey = stream.remotePublicKey.toString('hex')
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
    this._extensions.set(remoteKey, extension)
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

    this.topicsByName = new Map()
    this.streamsByKey = new Map()
    this.streamsByDiscoveryKey = new Map()

    this._joinListener = this._onjoin.bind(this)
    this.networker.on('handshake', this._joinListener)
  }

  _onjoin (stream, peerInfo) {
    const remoteKey = stream.remotePublicKey
    const keyString = remoteKey.toString('hex')
    stream.on('close', this._onleave.bind(this, stream))
    this.streamsByKey.set(keyString, stream)
    if (peerInfo && peerInfo.topic) {
      const dkeyStreams = upsert(this.streamsByDiscoveryKey, peerInfo.topic.toString('hex'), () => [])
      dkeyStreams.push(stream)
    }
    // Register all topic extensions on the new stream
    for (const [, topic] of this.topicsByName) {
      topic.registerExtension(stream)
    }
  }

  _onleave (stream, peerInfo, finishedHandshake) {
    if (!finishedHandshake) return
    const remoteKey = stream.remotePublicKey
    const keyString = remoteKey.toString('hex')
    const supportedTopics = this.supportedTopicsByPeer.get(keyString)
    for (const [, topic] of this.topicsByName) {
      topic.removeExtension(keyString)
    }
    this.streamsByKey.delete(keyString)
    if (peerInfo && peerInfo.topic) {
      const dkeyStreams = this.streamsByDiscoveryKey.get(peerInfo.topic.toString('hex'))
      if (!dkeyStreams) return
      dkeyStreams.splice(dkeyStreams.indexOf(stream), 1)
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
    let topic = this.topicsByName.get(topicName)
    if (topic) {
    }
    // Close the topic (this destroys every stream's per-topic extension)
    topic.close()
  }

  stop () {
    if (!this._joinListener) return
    this.networker.removeListener('handshake', this._joinListener)
    this._joinListener = null
  }

  listPeers (discoveryKey) {
    if (!discoveryKey) {
      return [...this.streamsByKey].map(([,stream]) => stream)
    }
    if (Buffer.isBuffer(discoveryKey)) discoveryKey = discoveryKey.toString('hex')
    return this.streamsByDiscoveryKey.get(discoveryKey)
  }
}
Peersockets.EXTENSION_PREFIX = 'peersockets/v0/'

function upsert (map, key, createFn) {
  if (map.has(key)) return map.get(key)
  let value = createFn()
  map.set(key, value)
  return value
}

module.exports = Peersockets
