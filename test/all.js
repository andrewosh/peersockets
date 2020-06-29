const test = require('tape')
const dht = require('@hyperswarm/dht')
const ram = require('random-access-memory')
const hypercoreCrypto = require('hypercore-crypto')
const CorestoreNetworker = require('@corestore/networker')
const HypercoreProtocol = require('hypercore-protocol')
const Corestore = require('corestore')

const Peersockets = require('..')

const BOOTSTRAP_PORT = 3100
var bootstrap = null

test('static peers, single peer send', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()
  const ps1 = new Peersockets(networker1)
  const ps2 = new Peersockets(networker2)
  const topic = 'test-topic-1'

  const dkey = hypercoreCrypto.randomBytes(32)
  await networker1.configure(dkey, { announce: true, lookup: true })

  const handle1 = ps1.join(topic)
  let seenProm = new Promise(resolve => {
    ps2.join(topic, {
      onmessage: (msg, peer) => {
        t.same(msg.toString('utf8'), 'hello world!')
        return resolve()
      }
    })
  })

  networker1.on('peer-add', peer => {
    handle1.send('hello world!', peer)
  })

  await networker2.configure(dkey, { announce: true, lookup: true })

  await seenProm
  t.pass('single message was seen')

  await cleanup([networker1, networker2])
  t.end()
})

test('static peers, multiple topics bidirectional send', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()
  const ps1 = new Peersockets(networker1)
  const ps2 = new Peersockets(networker2)
  let seen = 0

  const ps1Key = networker1.keyPair.publicKey
  const ps2Key = networker2.keyPair.publicKey

  const sharedKey = hypercoreCrypto.randomBytes(32)
  const topic1 = 'test-topic-1'
  const topic2 = 'test-topic-2'

  await networker1.configure(sharedKey, { announce: true, lookup: true })
  await networker2.configure(sharedKey, { announce: true, lookup: true })

  const ps1Topic1 = ps1.join(topic1, {
    onmessage: (msg, peer) => {
      t.same(msg.toString('utf8'), 'topic1 to ps1')
      seen++
    }
  })
  const ps1Topic2 = ps1.join(topic2, {
    onmessage: (msg, peer) => {
      t.same(msg.toString('utf8'), 'topic2 to ps1')
      seen++
    }
  })
  const ps2Topic1 = ps2.join(topic1, {
    onmessage: (msg, peer) => {
      t.same(msg.toString('utf8'), 'topic1 to ps2')
      seen++
    }
  })
  const ps2Topic2 = ps2.join(topic2, {
    onmessage: (msg, peer) => {
      t.same(msg.toString('utf8'), 'topic2 to ps2')
      seen++
    }
  })

  await delay(100)

  ps1Topic1.send('topic1 to ps2', findPeer(networker1.peers, ps2Key))
  ps1Topic2.send('topic2 to ps2', findPeer(networker1.peers, ps2Key))
  ps2Topic1.send('topic1 to ps1', findPeer(networker2.peers, ps1Key))
  ps2Topic2.send('topic2 to ps1', findPeer(networker2.peers, ps1Key))

  await cleanup([networker1, networker2])
  t.same(seen, 4)
  t.end()
})

test('dynamic peer, single peer send', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()
  const ps1 = new Peersockets(networker1)
  const ps2 = new Peersockets(networker2)
  let seen = 0

  const sharedKey = hypercoreCrypto.randomBytes(32)
  const topic = 'test-topic-1'

  await networker1.configure(sharedKey, { announce: true, lookup: true })
  await networker2.configure(sharedKey, { announce: true, lookup: true })

  const handle1 = ps1.join(topic)
  const handle2 = ps2.join(topic, {
    onmessage: (msg, peer) => {
      t.same(msg.toString('utf8'), 'hello world!')
      seen++
    }
  })

  await delay(100)

  handle1.send('hello world!', findPeer(networker1.peers, networker2.keyPair.publicKey))

  await cleanup([networker1, networker2])
  t.same(seen, 1)
  t.end()
})

test('can close a topic handle without closing the topic', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()
  const ps1 = new Peersockets(networker1)
  const ps2 = new Peersockets(networker2)
  let seen = 0

  const sharedKey = hypercoreCrypto.randomBytes(32)
  const topic = 'test-topic-1'

  await networker1.configure(sharedKey, { announce: true, lookup: true })
  await networker2.configure(sharedKey, { announce: true, lookup: true })
  const handle1 = ps1.join(topic)
  const handle2 = ps1.join(topic)
  const handle3 = ps2.join(topic, {
    onmessage: (msg, peer) => {
      t.same(msg.toString('utf8'), 'hello world!')
      seen++
    }
  })

  await delay(100)

  handle1.send('hello world!', findPeer(networker1.peers, networker2.keyPair.publicKey))
  handle1.close()
  handle2.send('hello world!', findPeer(networker1.peers, networker2.keyPair.publicKey))

  await delay(100)

  await cleanup([networker1, networker2])
  t.same(seen, 2)
  t.end()
})

test('leaving a topic removes the extension', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()
  const ps1 = new Peersockets(networker1)
  const ps2 = new Peersockets(networker2)

  const sharedKey = hypercoreCrypto.randomBytes(32)
  const topic = 'test-topic-1'
  await networker1.configure(sharedKey, { announce: true, lookup: true })
  await networker2.configure(sharedKey, { announce: true, lookup: true })
  const peerKey = networker2.keyPair.publicKey
  let errored = false

  await delay(100)

  const handle1 = ps1.join(topic)
  handle1.send('this should not error', findPeer(networker1.peers, peerKey))
  ps1.leave(topic)
  try {
    handle1.send(peerKey, 'this should error')
  } catch (err) {
    errored = true
  }

  t.true(errored)
  await cleanup([networker1, networker2])
  t.end()
})

test('connections persist across deduplication events', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()
  const { networker: networker3 } = await create({
    keyPair: networker2.keyPair
  })

  const ps1 = new Peersockets(networker1)
  const ps2 = new Peersockets(networker2)
  const ps3 = new Peersockets(networker3)
  const topic = 'test-topic-1'
  let ps1Seen = 0
  let ps2Seen = 0
  let ps3Seen = 0

  const dkey = hypercoreCrypto.randomBytes(32)

  await networker1.configure(dkey, { announce: true, lookup: true })
  await networker2.configure(dkey, { announce: true, lookup: true })

  const handle1 = ps1.join(topic, {
    onmessage: msg => {
      t.same(msg.toString('utf8'), 'hello world!')
      ps1Seen++
    }
  })
  const handle2 = ps2.join(topic, {
    onmessage: msg => {
      t.same(msg.toString('utf8'), 'hello world!')
      ps2Seen++
    }
  })
  const handle3 = ps3.join(topic, {
    onmessage: msg => {
      t.same(msg.toString('utf8'), 'hello world!')
      ps3Seen++
    }
  })

  await delay(100)
  handle1.send('hello world!', findPeer(networker1.peers, networker2.keyPair.publicKey))

  await delay(100)
  // This should trigger a duplication event in ps1
  await networker3.configure(dkey, { announce: true, lookup: true })
  await delay(100)

  // Depending on the keyPair, this might trigger a deduplication event.
  // Regardless of which connection is deduped, networker2 and networker3 should see at most 2 messages between them.
  handle1.send('hello world!', findPeer(networker1.peers, networker2.keyPair.publicKey))
  await delay(100)

  handle3.send('hello world!', findPeer(networker3.peers, networker1.keyPair.publicKey))
  await delay(100)

  await cleanup([networker1, networker2, networker3])
  t.same(ps1Seen, 1)
  t.true(ps2Seen + ps3Seen === 2)
  t.end()
})

function findPeer (peers, remotePublicKey) {
  for (const peer of peers) {
    if (peer.remotePublicKey && peer.remotePublicKey.equals(remotePublicKey)) return peer
  }
  return null
}

async function create (opts = {}) {
  if (!bootstrap) {
    bootstrap = dht({
      bootstrap: false
    })
    bootstrap.listen(BOOTSTRAP_PORT)
    await new Promise(resolve => {
      return bootstrap.once('listening', resolve)
    })
  }
  const store =  new Corestore(ram)
  await store.ready()
  const networker = new CorestoreNetworker(store,  { ...opts, bootstrap: `localhost:${BOOTSTRAP_PORT}` })
  return { store, networker }
}

async function cleanup (networkers) {
  for (let networker of networkers) {
    await networker.close()
  }
  if (bootstrap) {
    await bootstrap.destroy()
    bootstrap = null
  }
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
