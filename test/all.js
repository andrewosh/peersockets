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

  const sharedKey = hypercoreCrypto.randomBytes(32)
  const topic = 'test-topic-1'

  await networker1.join(sharedKey, { announce: true, lookup: true })
  await networker2.join(sharedKey, { announce: true, lookup: true })

  const handle1 = ps1.join(topic)
  const handle2 = ps2.join(topic, {
    onmessage: (remoteKey, msg) => {
      t.same(msg.toString('utf8'), 'hello world!')
    }
  })
  handle1.send(networker2.keyPair.publicKey, 'hello world!')

  await delay(100)
  await cleanup([networker1, networker2])
  t.end()
})

test('static peers, multi-peer broadcast', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()
  const { networker: networker3 } = await create()
  const { networker: networker4 } = await create()
  const ps1 = new Peersockets(networker1)
  const ps2 = new Peersockets(networker2)
  const ps3 = new Peersockets(networker3)
  const ps4 = new Peersockets(networker4)

  const sharedKey = hypercoreCrypto.randomBytes(32)
  const topic = 'test-topic-1'
  const otherTopic = 'other-topic-1'

  await networker1.join(sharedKey, { announce: true, lookup: true })
  await networker2.join(sharedKey, { announce: true, lookup: true })
  await networker3.join(sharedKey, { announce: true, lookup: true })
  await networker4.join(sharedKey, { announce: true, lookup: true })

  // networker3 does not join the topic
  const handle1 = ps1.join(topic)
  const handle2 = ps2.join(topic, {
    onmessage: (remoteKey, msg) => {
      console.log('handle2 got message')
      t.same(msg.toString('utf8'), 'hello world!')
    }
  })
  const handle4 = ps4.join(topic, {
    onmessage: (remoteKey, msg) => {
      console.log('handle4 got message')
      t.same(msg.toString('utf8'), 'hello world!')
    }
  })
  const handle3 = ps3.join(otherTopic, {
    onmessage: (remoteKey, msg) => {
      t.fail('handle3 should not have received broadcast')
    }
  })
  handle1.broadcast('hello world!')

  await delay(100)
  await cleanup([networker1, networker2, networker3, networker4])
  t.end()
})

test.only('static peers, multi-peer, multi-topic broadcasts', async t => {
  const NUM_PEERS = 20
  const NUM_TOPICS = 5

  const sockets = []
  const networkers = []
  const senders = []
  const messageCounts = (new Array(NUM_TOPICS)).fill(0)

  const sharedKey = hypercoreCrypto.randomBytes(32)

  for (let i = 0; i < NUM_PEERS; i++) {
    const { networker } = await create()
    const socket = new Peersockets(networker)
    await networker.join(sharedKey, { announce: true, lookup: true })
    networkers.push(networker)
    sockets.push(socket)
  }

  for (let i = 0; i < NUM_PEERS; i++) {
    const socket = sockets[i]
    for (let j = 1; j <= NUM_TOPICS; j++) {
      if (i % j) continue
      console.log(`peer ${i} joining topic ${j}`)
      const handle = socket.join('topic-' + j, {
        onmessage: (_, msg) => {
          messageCounts[j - 1]++
        }
      })
      if (!i) senders[j] = handle
    }
  }

  await delay(2000)

  // socket 0 is a member of all topics.
  for (let i = 1; i <= NUM_TOPICS; i++) {
    const sender = senders[i]
    console.log('broadcasting')
    sender.broadcast(`hello topic #${i}`)
  }

  await delay(200)

  for (let i = 0; i < messageCounts.length; i++) {
    t.same(messageCounts[i], Math.floor(NUM_PEERS / (i + 1)))
  }

  await cleanup(networkers)
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
