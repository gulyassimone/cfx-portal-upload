import axios from 'axios'
import * as core from '@actions/core'
import { resolveAssetId } from '../src/utils'

jest.mock('axios')

const get = jest.spyOn(axios, 'get')
const post = jest.spyOn(axios, 'post')

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(core, 'info').mockImplementation(() => {})
  jest.spyOn(core, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

test('creates an asset when no exact asset exists', async () => {
  get.mockResolvedValue({ data: { items: [] } } as never)
  post.mockResolvedValue({ data: { id: 42 } } as never)

  await expect(resolveAssetId('sa garage', 'test-cookie')).resolves.toBe('42')

  expect(post).toHaveBeenCalledWith(
    'https://portal-api.cfx.re/v1/me/assets',
    { name: 'sa garage' },
    { headers: { Cookie: 'test-cookie' } }
  )
})

test('uses an existing exact asset without creating one', async () => {
  get.mockResolvedValue({
    data: { items: [{ id: 7, name: 'sa_garage' }] }
  } as never)

  await expect(resolveAssetId('sa_garage', 'test-cookie')).resolves.toBe('7')
  expect(post).not.toHaveBeenCalled()
})
