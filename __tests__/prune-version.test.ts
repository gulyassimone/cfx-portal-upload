/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-explicit-any */
import * as core from '@actions/core'
import axios from 'axios'
import {
  oldestRemovableVersion,
  pruneOldestVersion
} from '../src/prune-version'
import { PortalAsset } from '../src/types'

jest.mock('axios')
const asset = (versions: PortalAsset['versions']): PortalAsset => ({
  id: 7,
  name: 'sa_garage',
  state: 'active',
  versions
})
const active = (id: number): PortalAsset['versions'][number] => ({
  id,
  state: 'active',
  packs: [{ id: id + 100, game: 'gta5' }]
})

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(core, 'info').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

test('does not delete on first upload or when only one version exists', async () => {
  const get = jest.mocked(axios.get)
  const remove = jest.mocked(axios.delete)
  get.mockResolvedValueOnce({ data: asset([]), status: 200 } as any)
  get.mockResolvedValueOnce({ data: asset([active(1)]), status: 200 } as any)
  await pruneOldestVersion('7', 'cookie', '2.0.0')
  await pruneOldestVersion('7', 'cookie', '2.0.0')
  expect(remove).not.toHaveBeenCalled()
})

test('deletes only the oldest version while another downloadable version remains', async () => {
  jest.mocked(axios.get).mockResolvedValue({
    data: asset([active(30), active(10), active(20)]),
    status: 200
  } as any)
  jest.mocked(axios.delete).mockResolvedValue({ status: 204 } as any)
  await pruneOldestVersion('7', 'cookie', '2.0.0')
  expect(axios.delete).toHaveBeenCalledTimes(1)
  expect(axios.delete).toHaveBeenCalledWith(
    'https://portal-api.cfx.re/v1/assets/7/versions/10',
    { headers: { Cookie: 'cookie' } }
  )
})

test('rejects deletion if it would remove the only downloadable version', () => {
  expect(() =>
    oldestRemovableVersion(
      asset([active(1), { id: 2, state: 'processing', packs: [] }])
    )
  ).toThrow('no other active downloadable version')
})

test('rejects malformed or mismatched Portal inventory before deletion', async () => {
  expect(() => oldestRemovableVersion(asset([active(1), active(1)]))).toThrow(
    'duplicate version IDs'
  )
  jest.mocked(axios.get).mockResolvedValue({
    data: { ...asset([active(1), active(2)]), id: 8 },
    status: 200
  } as any)
  await expect(pruneOldestVersion('7', 'cookie', '2.0.0')).rejects.toThrow(
    'asset ID changed'
  )
  expect(axios.delete).not.toHaveBeenCalled()
})

test('does not delete a different version when the requested version already exists', async () => {
  jest.mocked(axios.get).mockResolvedValue({
    data: asset([
      { ...active(1), version: '1.0.0' },
      { ...active(2), version: '2.0.0' }
    ]),
    status: 200
  } as any)
  await expect(pruneOldestVersion('7', 'cookie', '2.0.0')).rejects.toThrow(
    'already exists'
  )
  expect(axios.delete).not.toHaveBeenCalled()
})
