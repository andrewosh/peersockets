const test = require('tape')
const dht = require('@hyperswarm/dht')
const ram = require('random-access-memory')
const hypercoreCrypto = require('hypercore-crypto')
const SwarmNetworker = require('corestore-swarm-networking')
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
  let seen = 0
  const topic = 'test-topic-1'

  const dkey = hypercoreCrypto.randomBytes(32)

  await networker1.join(dkey, { announce: true, lookup: true })
  await networker2.join(dkey, { announce: true, lookup: true })

  const handle1 = ps1.join(topic)
  const handle2 = ps2.join(topic, {
    onmessage: (remoteKey, msg) => {
      t.same(msg.toString('utf8'), 'hello world!')
      seen++
    }
  })

  await delay(100)
  handle1.send(networker2.keyPair.publicKey, 'hello world!')

  await cleanup([networker1, networker2])
  t.same(seen, 1)
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

  await networker1.join(sharedKey, { announce: true, lookup: true })
  await networker2.join(sharedKey, { announce: true, lookup: true })

  // networker3 does not join the topic
  const ps1Topic1 = ps1.join(topic1, {
    onmessage: (remoteKey, msg) => {
      t.same(msg.toString('utf8'), 'topic1 to ps1')
      seen++
    }
  })
  const ps1Topic2 = ps1.join(topic2, {
    onmessage: (remoteKey, msg) => {
      t.same(msg.toString('utf8'), 'topic2 to ps1')
      seen++
    }
  })
  const ps2Topic1 = ps2.join(topic1, {
    onmessage: (remoteKey, msg) => {
      t.same(msg.toString('utf8'), 'topic1 to ps2')
      seen++
    }
  })
  const ps2Topic2 = ps2.join(topic2, {
    onmessage: (remoteKey, msg) => {
      t.same(msg.toString('utf8'), 'topic2 to ps2')
      seen++
    }
  })

  ps1Topic1.send(ps2Key, 'topic1 to ps2')
  ps1Topic2.send(ps2Key, 'topic2 to ps2')
  ps2Topic1.send(ps1Key, 'topic1 to ps1')
  ps2Topic2.send(ps1Key, 'topic2 to ps1')

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

  await networker1.join(sharedKey, { announce: true, lookup: true })
  const handle1 = ps1.join(topic)

  await delay(100)

  await networker2.join(sharedKey, { announce: true, lookup: true })
  const handle2 = ps2.join(topic, {
    onmessage: (remoteKey, msg) => {
      t.same(msg.toString('utf8'), 'hello world!')
      seen++
    }
  })
  handle1.send(networker2.keyPair.publicKey, 'hello world!')

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

  await networker1.join(sharedKey, { announce: true, lookup: true })
  const handle1 = ps1.join(topic)
  const handle2 = ps1.join(topic)

  await delay(100)

  await networker2.join(sharedKey, { announce: true, lookup: true })
  const handle3 = ps2.join(topic, {
    onmessage: (remoteKey, msg) => {
      t.same(msg.toString('utf8'), 'hello world!')
      seen++
    }
  })
  handle1.send(networker2.keyPair.publicKey, 'hello world!')
  handle1.close()
  handle2.send(networker2.keyPair.publicKey, 'hello world!')
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
  await networker1.join(sharedKey, { announce: true, lookup: true })
  await networker2.join(sharedKey, { announce: true, lookup: true })
  const peerKey = networker2.keyPair.publicKey
  let errored = false

  const handle1 = ps1.join(topic)
  handle1.send(peerKey, 'this should not error')
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

test('can list peers for a discovery key', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()
  const ps1 = new Peersockets(networker1)
  const ps2 = new Peersockets(networker2)

  const core1 = store1.default()
  const core2 = store2.get(core1.key)

  await networker1.join(core1.discoveryKey, { announce: true, lookup: true })
  await networker2.join(core2.discoveryKey, { announce: true, lookup: true })
  await delay(100)

  const firstPeers = await ps1.listPeers(core1.discoveryKey)
  const secondPeers = await ps2.listPeers(core2.discoveryKey)

  t.same(firstPeers.length, 1)
  t.same(secondPeers.length, 1)
  t.true(firstPeers[0].equals(networker2.keyPair.publicKey))
  t.true(secondPeers[0].equals(networker1.keyPair.publicKey))

  await cleanup([networker1, networker2])
  t.end()
})

test('can watch peers for a discovery key', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()
  const { store: store3, networker: networker3 } = await create()
  const ps1 = new Peersockets(networker1)
  const ps2 = new Peersockets(networker2)
  const ps3 = new Peersockets(networker3)

  const joinSet = new Set()
  const leaveSet = new Set()

  const joins = [networker2.keyPair.publicKey, networker3.keyPair.publicKey]
  const leaves = [networker3.keyPair.publicKey, networker2.keyPair.publicKey]

  const core1 = store1.get()
  const discoveryKey = hypercoreCrypto.discoveryKey(core1.key)

  await networker1.join(discoveryKey, { announce: true, lookup: true })
  let watcher = ps1.watchPeers(discoveryKey, {
    onjoin: (remoteKey) => {
      joinSet.add(remoteKey.toString('hex'))
    },
    onleave: (remoteKey) => {
      leaveSet.add(remoteKey.toString('hex'))
    }
  })

  const core2 = store2.get(core1.key)
  await networker2.join(discoveryKey, { announce: true, lookup: true })
  const core3 = store3.get(core1.key)
  await networker3.join(discoveryKey, { announce: true, lookup: true })

  await delay(100)
  t.same(joinSet.size, 2)
  t.true(joinSet.has(networker2.keyPair.publicKey.toString('hex')))
  t.true(joinSet.has(networker3.keyPair.publicKey.toString('hex')))

  await networker3.close()
  await networker2.close()

  await delay(100)
  t.same(leaveSet.size, 2)
  t.true(leaveSet.has(networker2.keyPair.publicKey.toString('hex')))
  t.true(leaveSet.has(networker3.keyPair.publicKey.toString('hex')))

  await cleanup([networker1])
  t.end()
})

test('stops watching peers when call is closed', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()
  const { store: store3, networker: networker3 } = await create()
  const ps1 = new Peersockets(networker1)
  const ps2 = new Peersockets(networker2)
  const ps3 = new Peersockets(networker3)

  const joinSet = new Set()
  const leaveSet = new Set()

  const joins = [networker2.keyPair.publicKey, networker3.keyPair.publicKey]
  const leaves = [networker3.keyPair.publicKey, networker2.keyPair.publicKey]

  const core1 = store1.get()
  const discoveryKey = hypercoreCrypto.discoveryKey(core1.key)

  await networker1.join(discoveryKey, { announce: true, lookup: true })
  let watcher = ps1.watchPeers(discoveryKey, {
    onjoin: (remoteKey) => {
      joinSet.add(remoteKey.toString('hex'))
    },
    onleave: (remoteKey) => {
      leaveSet.add(remoteKey.toString('hex'))
    }
  })

  const core2 = store2.get(core1.key)
  await networker2.join(discoveryKey, { announce: true, lookup: true })
  const core3 = store3.get(core1.key)
  await networker3.join(discoveryKey, { announce: true, lookup: true })

  await delay(100)
  t.same(joinSet.size, 2)
  const firstLeaveSize = leaveSet.size
  const firstJoinSize = joinSet.size
  t.true(joinSet.has(networker2.keyPair.publicKey.toString('hex')))
  t.true(joinSet.has(networker3.keyPair.publicKey.toString('hex')))

  // Close the watcher
  watcher()

  await networker3.close()
  await networker2.close()

  await delay(100)
  t.same(leaveSet.size, firstLeaveSize)
  t.same(joinSet.size, firstJoinSize)

  await cleanup([networker1])
  t.end()
})

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
  const networker = new SwarmNetworker(store,  { ...opts, bootstrap: `localhost:${BOOTSTRAP_PORT}` })
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
