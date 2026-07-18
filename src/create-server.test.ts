import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./tools/registry.js', () => ({ registerTools: vi.fn() }))

import { createMCPServer } from './create-server.js'
import { registerTools } from './tools/registry.js'

describe('createMCPServer', () => {
  it('returns a Server with tools registered', () => {
    const server = createMCPServer()

    expect(server).toBeInstanceOf(Server)
    expect(registerTools).toHaveBeenCalledWith(server)
  })
})
