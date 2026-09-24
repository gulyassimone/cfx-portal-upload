import * as core from '@actions/core'
import { AxiosResponse } from 'axios'
import { logPortalRequest } from '../src/portal-log'

jest.mock('@actions/core')

beforeEach(() => jest.clearAllMocks())

test('logs request boundaries and returns the unchanged response', async () => {
  const response = { status: 200, data: { version_id: 42 } } as AxiosResponse
  await expect(
    logPortalRequest(
      'POST /assets/7/re-upload',
      async () => await Promise.resolve(response)
    )
  ).resolves.toBe(response)
  expect(core.info).toHaveBeenCalledWith(
    expect.stringContaining('POST /assets/7/re-upload - starting')
  )
  expect(core.info).toHaveBeenCalledWith(expect.stringContaining('HTTP 200'))
})

test('identifies failed chunks and redacts secrets while preserving the original error', async () => {
  const error = Object.assign(new Error('Request failed'), {
    response: {
      status: 503,
      headers: { 'x-request-id': 'request-42', 'set-cookie': 'private-header' },
      data: {
        message:
          'storage unavailable; session-cookie-value https://storage.example/file?sig=private-signature',
        token: 'private-token',
        nested: { password: 'private-password' }
      }
    },
    config: { headers: { Cookie: 'private-config' } }
  })
  await expect(
    logPortalRequest(
      'POST /assets/7/upload-chunk (chunk_id=0)',
      async () => {
        return await Promise.reject(error)
      },
      ['session=session-cookie-value']
    )
  ).rejects.toBe(error)
  const output = JSON.stringify([
    jest.mocked(core.info).mock.calls,
    jest.mocked(core.error).mock.calls
  ])
  expect(output).toContain('chunk_id=0')
  expect(output).toContain('HTTP 503')
  expect(output).toContain('storage unavailable')
  expect(output).toContain('request-42')
  for (const secret of [
    'private-header',
    'private-signature',
    'private-token',
    'private-password',
    'private-config',
    'session-cookie-value'
  ])
    expect(output).not.toContain(secret)
})

test('reports network failures without dumping the error config', async () => {
  const error = Object.assign(new Error('Connection reset'), {
    code: 'ECONNRESET',
    config: { secret: 'hidden' }
  })
  await expect(
    logPortalRequest('GET signed ZIP', async () => {
      return await Promise.reject(error)
    })
  ).rejects.toBe(error)
  expect(core.error).toHaveBeenCalledWith(
    expect.stringContaining('no HTTP response')
  )
  expect(core.error).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'))
})
