import { describe, expect, it, vi } from 'vitest'

vi.mock('./main.js', () => ({
  startServer: vi.fn(),
  getTransportMode: vi.fn(() => 'stdio')
}))

import { initServer } from './init-server.js'
import { getTransportMode, startServer } from './main.js'

describe('initServer', () => {
  it('dynamically imports main and starts the server with the resolved transport mode', async () => {
    await initServer()

    expect(getTransportMode).toHaveBeenCalledOnce()
    expect(startServer).toHaveBeenCalledWith('stdio')
  })
})
