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
  send (msg, peer) {
    this._topic.send(msg, peer)
  }
}

class Topic extends EventEmitter {
  constructor (name, ext) {
    super()
    this.name = name
    this._extension = ext
    this._handles = []
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

  onmessage (message, from) {
    for (const handle of this._handles) {
      if (handle.onmessage) handle.onmessage(message, from)
    }
  }

  send (msg, peer) {
    this._extension.send(msg, peer)
  }

  close () {
    this._extension.destroy()
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
  }

  join (topicName, opts) {
    let topic = this.topicsByName.get(topicName)
    if (topic) return topic.createHandle(opts)
    const extension = this.networker.registerExtension({
      name: Peersockets.EXTENSION_PREFIX + topicName,
      onmessage: (message, from) => {
        topic.onmessage(message, from)
      }
    })
    topic = new Topic(topicName, extension)
    this.topicsByName.set(topicName, topic)
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
    for (const topic of this.topicsByName.values()) {
      topic.close()
    }
    this.topicsByName.clear()
  }

  /*
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
      if (!peer.remoteOpened) return
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
  */
}
Peersockets.EXTENSION_PREFIX = 'peersockets/v0/'

module.exports = Peersockets
