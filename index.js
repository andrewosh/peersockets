const { EventEmitter } = require('events')
const messages = require('./lib/messages')
const streamx = require('streamx')

class TopicHandle {
  constructor (topic, opts = {}) {
    this._topic = topic
    this.onjoin = opts.onjoin
    this.onleave = opts.onleave
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
  broadcast (msg) {
    this._topic.broadcast(msg)
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
    if (!extension) return
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
  static EXTENSION_PREFIX = 'peersockets/v0/'

  constructor (networker) {
    super()
    this.networker = networker

    this.topicsByName = new Map()
    this.streamsByKey = new Map()

    this._joinListener = null
    this._leaveListener = null
    this.start()
  }

  _registerCoordinationExtension (remoteKey, stream) {
    const onmessage = (msg) => {
      let supportedTopics = upsert(this.supportedTopicsByPeer, remoteKey, () => new Set())
      if (msg.added) {
        for (const topicName of msg.added) {
          let supportedPeers = upsert(this.supportedPeersByTopic, remoteKey, () => new Set())
          supportedTopics.add(topicName)
          supportedPeers.add(remoteKey)
          const topics = this.topicsByName.get(topicName)
          if (!topics) continue
          for (const topic of topics) {
            topic.addPeer(remoteKey, stream)
          }
        }
      }
      if (msg.removed) {
        for (const topicName of msg.removed) {
          let supportedPeers = this.supportedPeersByTopic.get(remoteKey)
          if (supportedPeers) supportedPeers.delete(remoteKey)
          this.supportedTopicsByPeer.delete(remoteKey)
          const topics = this.topicsByName.get(topicName)
          if (!topics) continue
          for (const topic of topics) {
            topic.remotePeer(remoteKey, stream)
          }
        }
      }
    }
    const coordinator = {
      encoding: messages.SupportedExtensionsMessage,
      onmessage
    }
    const extension = stream.registerExtension(Peersockets.COORDINATOR_EXTENSION, coordinator)
    this.coordinatorsByKey.set(remoteKey, extension)
    return extension
  }

  _onjoin (stream) {
    const remoteKey = stream.remotePublicKey
    const keyString = remoteKey.toString('hex')
    this.streamsByKey.set(keyString, stream)
    stream.on('close', this._onleave.bind(this, stream))
    const coordinator = this._registerCoordinationExtension(keyString, stream)
    // Register all topic extensions on the new stream
    for (const [, topic] of this.topicsByName) {
      topic.registerExtension(stream)
    }
    // Notify the remote of all the extensions we support.
    coordinator.send({
      added: [...this.topicsByName].map(([k,]) => k)
    })
  }

  _onleave (stream, _, finishedHandshake) {
    if (!finishedHandshake) return
    const remoteKey = stream.remotePublicKey
    const keyString = remoteKey.toString('hex')
    const supportedTopics = this.supportedTopicsByPeer.get(keyString)
    if (supportedTopics) {
      for (const topicName of supportedTopics) {
        const topic = this.topicsByName.get(topicName)
        if (!topic) continue
        topic.removePeer(keyString, stream)
      }
    }
    this.streamsByKey.delete(keyString)
  }

  join (topicName, opts) {
    let topic = this.topicsByName.get(topicName)
    if (topic) return topic
    topic = new Topic(topicName)
    this.topicsByName.set(topicName, topic)
    // Register the topic extension on all streams.
    for (const [,stream] of this.streamsByKey) {
      topic.registerExtension(stream)
    }
    // Add all supported peers to the topic
    const supportedPeers = this.supportedPeersByTopic.get(topicName)
    if (supportedPeers && supportedPeers.size) {
      for (const peerKey of supportedPeers) {
        topic.addPeer(peerKey, this.streamsByKey.get(peerKey))
      }
    }
    // Notify all peers that we support the topic.
    for (const [, coordinator] of this.coordinatorsByKey) {
      coordinator.send({
        added: [topicName]
      })
    }
  }

  leave (topicName) {
    let topic = this.topicsByName.get(topicName)
    if (!topic) return
    // Close the topic (this destroys every stream's per-topic extension)
    topic.close()
    // Notify all peers that we support the topic.
    for (const [, coordinator] of this.coordinatorsByKey) {
      coordinator.send({
        removed: [topicName]
      })
    }

    this.supportedPeersByTopic.delete(topicName)
    for (const [, topicSet] of this.supportedTopicsByPeer) {
      topicSet.delete(topicName)
    }
  }

  start () {
    if (this._joinListener) return
    this._joinListener = this._onjoin.bind(this)
    this.networker.on('handshake', this._joinListener)
  }

  stop () {
    if (this._joinListener) {
      this.networker.removeListener('handshake', this._joinListener)
      this._joinListener = null
    }
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
