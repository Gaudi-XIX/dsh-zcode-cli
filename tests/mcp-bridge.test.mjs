import assert from 'node:assert/strict'
import test from 'node:test'

import {
  McpServerSession,
  MCP_PROTOCOL_VERSION,
  negotiateProtocolVersion,
} from '../lib/mcp/protocol.js'
import { projectDshTools, validateToolArguments } from '../lib/mcp/tool-projection.js'
import { mountMcpEndpoint } from '../lib/mcp/endpoint.js'
import { startDshMcpBridge, ZCODE_MCP_SERVER_NAME } from '../lib/mcp/bridge.js'

/** A fake host HTTP carrier that records the routes plugins claim. */
function fakeWebServer(port = 43117) {
  const routes = new Map()
  return {
    port,
    host: '127.0.0.1',
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

/** Drive the mounted route the way ZCode would: loopback socket, bearer token. */
async function postRoute(webServer, path, token, body) {
  const route = webServer.routes.get(path)
  assert.ok(route, `route ${path} is mounted`)
  let status
  let payload = ''
  const res = {
    headersSent: false,
    writeHead(code) {
      status = code
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined) payload += chunk
    },
  }
  const req = {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8')
    },
  }
  await route.handler(req, res)
  return { status, body: payload }
}

test('MCP session negotiates the protocol version and answers initialize', async () => {
  const session = new McpServerSession({
    serverName: 'dsh',
    serverVersion: '1.0.0',
    instructions: 'bridge',
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
  })
  const response = await session.handleMessage(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'zcode', version: '0.17.0' } },
  }))
  assert.equal(response.result.protocolVersion, '2024-11-05')
  assert.equal(response.result.serverInfo.name, 'dsh')
  assert.equal(session.client.name, 'zcode')
})

test('MCP session never answers a notification', async () => {
  const session = new McpServerSession({
    serverName: 'dsh',
    serverVersion: '1.0.0',
    instructions: 'bridge',
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
  })
  const response = await session.handleMessage(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  }))
  assert.equal(response, undefined)
})

test('MCP session reports a malformed frame as a parse error', async () => {
  const session = new McpServerSession({
    serverName: 'dsh',
    serverVersion: '1.0.0',
    instructions: 'bridge',
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
  })
  const response = await session.handleMessage('{not json')
  assert.equal(response.error.code, -32700)
})

test('protocol version negotiation falls back to the server default', () => {
  assert.equal(negotiateProtocolVersion('2024-11-05'), '2024-11-05')
  assert.equal(negotiateProtocolVersion('1999-01-01'), MCP_PROTOCOL_VERSION)
  assert.equal(negotiateProtocolVersion(undefined), MCP_PROTOCOL_VERSION)
})

test('MCP session turns a throwing tool into an isError result, not a transport error', async () => {
  const session = new McpServerSession({
    serverName: 'dsh',
    serverVersion: '1.0.0',
    instructions: 'bridge',
    listTools: async () => [],
    callTool: async () => {
      throw new Error('host refused the call')
    },
  })
  const response = await session.handleMessage(JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'read', arguments: {} },
  }))
  assert.equal(response.error, undefined)
  assert.equal(response.result.isError, true)
  assert.match(response.result.content[0].text, /host refused the call/)
})

test('tool projection sorts names and reuses the protocol schema gate', () => {
  const projection = projectDshTools({
    schemas: () => [
      { name: 'write', description: 'w', parameters: { type: 'object', properties: {} } },
      { name: 'read', description: 'r', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'grep', description: 'g', parameters: { type: 'object', properties: {} } },
    ],
  })
  assert.deepEqual(projection.tools.map(tool => tool.name), ['grep', 'read', 'write'])
  assert.equal(projection.tools[1].inputSchema.type, 'object')
})

test('tool projection drops host-internal control tools and honours the allowlist', () => {
  const projection = projectDshTools({
    schemas: () => [
      { name: 'compress', description: 'c', parameters: { type: 'object' } },
      { name: 'read', description: 'r', parameters: { type: 'object' } },
      { name: 'write', description: 'w', parameters: { type: 'object' } },
    ],
  }, { allowlist: ['read'] })
  assert.deepEqual(projection.tools.map(tool => tool.name), ['read'])
  assert.ok(projection.excluded.includes('compress'))
  assert.ok(projection.excluded.includes('write'))
})

test('tool projection degrades an unusable schema to an open object instead of dropping the tool', () => {
  const projection = projectDshTools({
    schemas: () => [{ name: 'odd', description: 'o', parameters: 'not-a-schema' }],
  })
  assert.equal(projection.tools.length, 1)
  assert.deepEqual(projection.tools[0].inputSchema, {
    type: 'object',
    properties: {},
    additionalProperties: false,
  })
})

test('tool projection honours an explicit maxTools cap and names what it dropped', () => {
  const names = ['read', 'grep', 'write', 'glob', 'edit', 'pwsh']
  const projection = projectDshTools({
    schemas: () => names.map(name => ({ name, description: name, parameters: { type: 'object' } })),
  }, { maxTools: 3 })
  assert.deepEqual(projection.tools.map(tool => tool.name), ['grep', 'read', 'write'])
  assert.deepEqual([...projection.excluded].sort(), ['edit', 'glob', 'pwsh'])
})

test('tool projection leaves the default cap far above this machine\'s tool count', () => {
  const names = Array.from({ length: 73 }, (_, index) => `tool-${String(index).padStart(3, '0')}`)
  const projection = projectDshTools({
    schemas: () => names.map(name => ({ name, description: name, parameters: { type: 'object' } })),
  })
  assert.equal(projection.tools.length, 73)
  assert.deepEqual(projection.excluded, [])
})

test('the bridge asks the registry as the session agent, not as the global layer', async () => {
  const webServer = fakeWebServer()
  const agent = { id: 'agent-scoped' }
  const bridge = await startDshMcpBridge({
    webServer,
    tools: {
      // The global view (no scope) is the short UI/memory-only list. The file
      // and shell tools are an ancestor contribution of the agent plane, so a
      // scope-less call would silently hand ZCode a bridge with no `read`.
      schemas: scope => scope === undefined
        ? [{ name: 'click', description: 'c', parameters: { type: 'object' } }]
        : [
          { name: 'click', description: 'c', parameters: { type: 'object' } },
          { name: 'read', description: 'r', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
        ],
      async execute() {
        return { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] }
      },
    },
    sessionController: { async resolveAgent() { return agent } },
    serverVersion: '1.0.0',
  })
  bridge.setSession('session-scope')
  const path = new URL(bridge.url).pathname
  const { body } = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
    jsonrpc: '2.0', id: 11, method: 'tools/list', params: {},
  }))
  const names = JSON.parse(body).result.tools.map(tool => tool.name)
  assert.ok(names.includes('read'), 'the scoped agent plane reaches ZCode')
  await bridge.dispose()
})

test('the bridge resolves the session controller late, so a later mount is not lost', async () => {
  const webServer = fakeWebServer()
  let mounted = false
  const agent = { id: 'agent-late' }
  const bridge = await startDshMcpBridge({
    webServer,
    tools: {
      schemas: scope => scope === undefined
        ? [{ name: 'click', description: 'c', parameters: { type: 'object' } }]
        : [
          { name: 'click', description: 'c', parameters: { type: 'object' } },
          { name: 'read', description: 'r', parameters: { type: 'object' } },
        ],
      async execute() {
        return { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] }
      },
    },
    sessionControllerLookup: () => (mounted ? { async resolveAgent() { return agent } } : undefined),
    serverVersion: '1.0.0',
  })
  bridge.setSession('session-late')

  const path = new URL(bridge.url).pathname
  const list = async id => JSON.parse((await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/list', params: {},
  }))).body).result.tools.map(tool => tool.name)

  assert.deepEqual(await list(21), ['click'], 'no controller means the global view')
  mounted = true
  assert.ok((await list(22)).includes('read'), 'a controller mounted later still scopes the view')
  await bridge.dispose()
})

test('the bridge rejects a call that violates the advertised schema before the host runs it', async () => {
  const webServer = fakeWebServer()
  const executions = []
  const bridge = await startDshMcpBridge({
    webServer,
    tools: {
      schemas: () => [
        { name: 'memory_search', description: 'm', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
      ],
      async execute(exec) {
        executions.push(exec.name)
        return { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] }
      },
    },
    sessionController: { async resolveAgent() { return { agent: { id: 'a' } } } },
    serverVersion: '1.0.0',
  })
  bridge.setSession('session-args')
  const path = new URL(bridge.url).pathname
  const call = async (id, args) => JSON.parse((await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'memory_search', arguments: args },
  }))).body).result

  const empty = await call(21, {})
  assert.equal(empty.isError, true)
  assert.match(empty.content[0].text, /invalid arguments: missing required property "query"/)
  const wrongType = await call(22, { query: 123 })
  assert.equal(wrongType.isError, true)
  assert.match(wrongType.content[0].text, /"query" must be a string, got number/)
  assert.deepEqual(executions, [], 'neither call reached the host pipeline')

  // A type the schema does not describe is left to DSH, not guessed here.
  const unknownKey = await call(23, { query: 'ok', somethingElse: 7 })
  assert.equal(unknownKey.isError, false)
  assert.deepEqual(executions, ['memory_search'])

  const ghost = JSON.parse((await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
    jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'write', arguments: { file_path: 'x' } },
  }))).body).result
  assert.equal(ghost.isError, true)
  assert.match(ghost.content[0].text, /unknown tool "write"/)
  assert.deepEqual(executions, ['memory_search'], 'a tool ZCode was never shown does not run')

  await bridge.dispose()
})

test('validateToolArguments checks only what the schema declares', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      depth: { type: 'integer' },
      files: { type: 'array' },
      flags: { type: 'object' },
      on: { type: 'boolean' },
      any: {},
    },
    required: ['path'],
  }
  assert.deepEqual(validateToolArguments(schema, { path: 'a' }), [])
  assert.deepEqual(validateToolArguments(schema, { path: 1 }), ['"path" must be a string, got number'])
  assert.deepEqual(validateToolArguments(schema, { path: 'a', depth: 1.5 }), ['"depth" must be an integer, got number'])
  assert.deepEqual(validateToolArguments(schema, { path: 'a', files: 'x', on: 'yes' }), [
    '"files" must be an array, got string',
    '"on" must be a boolean, got string',
  ])
  assert.deepEqual(validateToolArguments(schema, { path: 'a', files: [], flags: {}, any: null }), [])
  assert.deepEqual(validateToolArguments(schema, {}), ['missing required property "path"'])
  assert.deepEqual(validateToolArguments(schema, undefined), ['arguments must be an object, got undefined'])
  assert.deepEqual(validateToolArguments(schema, ['a']), ['arguments must be an object, got array'])
  assert.deepEqual(validateToolArguments(schema, { path: 'a', undeclared: 1 }), [])
  // Nothing declared to check against means nothing to reject here.
  assert.deepEqual(validateToolArguments({ type: 'object' }, { anything: 1 }), [])
  assert.deepEqual(validateToolArguments(undefined, { anything: 1 }), [])
})

test('the mounted endpoint rejects a missing token and a non-loopback peer', async () => {
  const webServer = fakeWebServer()
  const endpoint = mountMcpEndpoint(webServer, {
    serverName: 'dsh',
    serverVersion: '1.0.0',
    instructions: 'bridge',
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
  })
  const path = new URL(endpoint.url).pathname

  const unauthorized = await postRoute(webServer, path, 'wrong-token', '{}')
  assert.equal(unauthorized.status, 401)

  const route = webServer.routes.get(path)
  let status
  const res = {
    headersSent: false,
    writeHead(code) { status = code; this.headersSent = true },
    end() {},
  }
  await route.handler({
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}` },
    socket: { remoteAddress: '10.0.0.5' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}') },
  }, res)
  assert.equal(status, 403)
})

test('the endpoint completes an initialize handshake over HTTP', async () => {
  const webServer = fakeWebServer()
  const endpoint = mountMcpEndpoint(webServer, {
    serverName: 'dsh',
    serverVersion: '1.0.0',
    instructions: 'bridge',
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
  })
  const path = new URL(endpoint.url).pathname
  const { status, body } = await postRoute(webServer, path, endpoint.token, JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION },
  }))
  assert.equal(status, 200)
  assert.equal(JSON.parse(body).result.serverInfo.name, 'dsh')
})

test('the bridge executes a tool through the host pipeline with the resolved agent', async () => {
  const webServer = fakeWebServer()
  const executions = []
  const agent = { id: 'agent-1' }
  const bridge = await startDshMcpBridge({
    webServer,
    tools: {
      schemas: () => [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
      async execute(exec) {
        executions.push(exec)
        return { isError: false, value: 'file contents', content: [{ type: 'text', text: 'file contents' }] }
      },
    },
    sessionController: {
      async resolveAgent(sessionId) {
        assert.equal(sessionId, 'session-abc')
        return { agent }
      },
    },
    serverVersion: '1.0.0',
  })
  assert.equal(bridge.active, true)

  bridge.setSession('session-abc')
  const path = new URL(bridge.url).pathname
  const { status, body } = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'read', arguments: { path: 'a.txt' } },
  }))
  assert.equal(status, 200)
  const parsed = JSON.parse(body)
  assert.equal(parsed.result.isError, false)
  assert.equal(parsed.result.content[0].text, 'file contents')

  // The whole point of the bridge: the call carries the live Agent, which is
  // what lets the host approval service route (or deny) the request.
  assert.equal(executions.length, 1)
  assert.equal(executions[0].agent, agent)
  assert.equal(executions[0].name, 'read')
  assert.deepEqual(executions[0].arguments, { path: 'a.txt' })
  assert.ok(executions[0].callId, 'a correlation id is minted')

  await bridge.dispose()
  assert.equal(webServer.routes.size, 0, 'dispose releases the route')
})

test('mcpServers descriptor matches the CLI strict schema shape', async () => {
  const webServer = fakeWebServer()
  const bridge = await startDshMcpBridge({
    webServer,
    tools: {
      schemas: () => [{ name: 'read', description: 'r', parameters: { type: 'object' } }],
      async execute() { return { isError: false, value: 'ok', content: [] } },
    },
    serverVersion: '1.0.0',
  })
  assert.equal(bridge.active, true)
  const entries = bridge.mcpServers()
  assert.equal(entries.length, 1)
  const entry = entries[0]
  assert.equal(entry.name, ZCODE_MCP_SERVER_NAME)
  assert.equal(entry.type, 'http')
  assert.equal(entry.url, bridge.url)
  assert.equal(entry.headers.length, 1)
  assert.equal(entry.headers[0].name, 'Authorization')
  assert.match(entry.headers[0].value, /^Bearer [0-9a-f]{64}$/)
  assert.deepEqual(Object.keys(entry).sort(), ['headers', 'name', 'type', 'url'],
    'no extra key: the session/create schema is .strict()')
  // Inactive bridges project nothing.
  const down = await startDshMcpBridge({
    webServer: undefined,
    tools: { schemas: () => [], execute: async () => ({ isError: false, value: null }) },
    serverVersion: '1.0.0',
  })
  assert.deepEqual(down.mcpServers(), [])
  await bridge.dispose()
})

test('the bridge fails closed when the host carrier is unavailable', async () => {
  const bridge = await startDshMcpBridge({
    webServer: undefined,
    tools: { schemas: () => [], execute: async () => ({ isError: false, value: null }) },
    serverVersion: '1.0.0',
  })
  assert.equal(bridge.active, false)
  assert.match(bridge.inactiveReason, /webServer/)
})

test('the bridge reports an error result instead of throwing when a tool fails', async () => {
  const webServer = fakeWebServer()
  const bridge = await startDshMcpBridge({
    webServer,
    tools: {
      schemas: () => [{ name: 'read', description: 'r', parameters: { type: 'object' } }],
      async execute() {
        return { isError: true, error: { message: 'denied by host policy' }, content: [] }
      },
    },
    sessionController: { async resolveAgent() { return { agent: { id: 'a' } } } },
    serverVersion: '1.0.0',
  })
  bridge.setSession('s1')
  const path = new URL(bridge.url).pathname
  const { body } = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'read', arguments: {} },
  }))
  const parsed = JSON.parse(body)
  assert.equal(parsed.result.isError, true)
  assert.match(parsed.result.content[0].text, /denied by host policy/)
  await bridge.dispose()
})
