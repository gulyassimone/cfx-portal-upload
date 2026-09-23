import axios from 'axios'
import fs from 'fs'
import * as core from '@actions/core'
import { parseUploadedVersion } from '../src/upload-version'
import { downloadAsset, waitForUploadedVersion } from '../src/deploy'
import { PortalAsset } from '../src/types'

jest.mock('axios')
let get: jest.SpiedFunction<typeof axios.get>
const uploaded = { assetId: 7, versionId: 102 }
const version = (
  id: number,
  state = 'active',
  packs = [{ id: id * 10, game: 'gta5' }]
): PortalAsset['versions'][number] => ({ id, state, packs })
function respond(
  versions: PortalAsset['versions'],
  id = 7
): { data: { items: PortalAsset[]; page_count: number } } {
  return {
    data: {
      items: [{ id, name: 'sa_garage', state: 'active', versions }],
      page_count: 1
    }
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  get = jest.spyOn(axios, 'get')
  jest.spyOn(core, 'info').mockImplementation(() => {})
})

test('retains the upload identity and rejects absent or mismatched IDs', () => {
  expect(parseUploadedVersion({ asset_id: 7, version_id: 102 }, '7')).toEqual(
    uploaded
  )
  for (const data of [
    null,
    {},
    { asset_id: 7 },
    { asset_id: 8, version_id: 102 },
    { asset_id: 7, version_id: -1 },
    { asset_id: 7, version_id: '102' }
  ]) {
    expect(() => parseUploadedVersion(data, '7')).toThrow(/blocked/)
  }
})

test('ignores an older active version while the uploaded one is processing', async () => {
  get
    .mockResolvedValueOnce(respond([version(101), version(102, 'processing')]))
    .mockResolvedValueOnce(respond([version(101), version(102)]))
  const result = await waitForUploadedVersion(
    'test-cookie',
    'sa_garage',
    uploaded,
    2,
    0
  )
  expect(result.version.id).toBe(102)
  expect(get).toHaveBeenCalledTimes(2)
})

test('does not deploy an unrelated newer active version', async () => {
  get
    .mockResolvedValueOnce(respond([version(103), version(102, 'processing')]))
    .mockResolvedValueOnce(respond([version(103), version(102)]))
  expect(
    (await waitForUploadedVersion('test', 'sa_garage', uploaded, 2, 0)).version
      .id
  ).toBe(102)
})

test('times out instead of falling back to the old version', async () => {
  get.mockResolvedValue(respond([version(101)]))
  await expect(
    waitForUploadedVersion('test', 'sa_garage', uploaded, 2, 0)
  ).rejects.toThrow(/No older version/)
})

test('waits for the pack of the exact uploaded version', async () => {
  get
    .mockResolvedValueOnce(respond([version(102, 'active', [])]))
    .mockResolvedValueOnce(respond([version(102)]))
  expect(
    (await waitForUploadedVersion('test', 'sa_garage', uploaded, 2, 0)).version
      .packs[0].id
  ).toBe(1020)
})

test('rejects a matching name with a different asset identity', async () => {
  get.mockResolvedValue(respond([version(102)], 8))
  await expect(
    waitForUploadedVersion('test', 'sa_garage', uploaded, 1, 0)
  ).rejects.toThrow(/does not match/)
})

test('downloads the pack URL of the uploaded version even when the old version is first', async () => {
  const bytes = Buffer.alloc(128)
  bytes.write('PK')
  const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
  get
    .mockResolvedValueOnce(respond([version(101), version(102)]))
    .mockResolvedValueOnce({
      data: { url: 'https://download.example.invalid/current.zip' }
    })
    .mockResolvedValueOnce({
      data: bytes,
      headers: { 'content-type': 'application/zip' }
    })
  try {
    await downloadAsset('test', 'sa_garage', uploaded)
    expect(get.mock.calls[1][0]).toBe(
      'https://portal-api.cfx.re/v1/assets/7/versions/102/packs/1020/download'
    )
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('sa_garage.zip'),
      bytes
    )
  } finally {
    write.mockRestore()
  }
})
