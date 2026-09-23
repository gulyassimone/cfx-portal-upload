import * as core from '@actions/core'
import axios from 'axios'
import puppeteer from 'puppeteer'
import { Browser } from 'puppeteer'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { run } from '../src/main'
import { deployAsset } from '../src/deploy'
import { preparePuppeteer, resolveAssetId, findAssetId } from '../src/utils'

jest.mock('axios')
jest.mock('../src/deploy', () => ({
  deployAsset: jest.fn(),
  rollbackToServer: jest.fn()
}))
jest.mock('../src/utils', () => ({
  ...jest.requireActual<typeof import('../src/utils')>('../src/utils'),
  preparePuppeteer: jest.fn(),
  resolveAssetId: jest.fn(),
  findAssetId: jest.fn()
}))

let post: jest.SpiedFunction<typeof axios.post>
let directory: string
let inputs: Record<string, string>
const page = {
  goto: jest.fn(),
  evaluate: jest.fn(),
  url: jest.fn(() => 'https://portal.cfx.re')
}
const browser = {
  newPage: jest.fn().mockResolvedValue(page),
  close: jest.fn(),
  setCookie: jest.fn(),
  cookies: jest.fn().mockResolvedValue([])
}

beforeEach(() => {
  jest.clearAllMocks()
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-upload-test-'))
  const zip = path.join(directory, 'resource.zip')
  fs.writeFileSync(zip, 'zip fixture')
  inputs = {
    chunkSize: '1024',
    maxRetries: '1',
    cookie: 'test-cookie',
    assetName: 'sa_garage',
    zipPath: zip,
    makeZip: 'false',
    deploy: 'true',
    ssh_host: 'example.invalid',
    ssh_user: 'test',
    ssh_key: 'test-key'
  }
  jest.spyOn(core, 'getInput').mockImplementation(name => inputs[name] || '')
  jest.spyOn(core, 'info').mockImplementation(() => {})
  jest.spyOn(core, 'debug').mockImplementation(() => {})
  jest.spyOn(core, 'setFailed').mockImplementation(() => {})
  jest
    .spyOn(puppeteer, 'launch')
    .mockResolvedValue(browser as unknown as Browser)
  page.evaluate.mockResolvedValue({ url: 'https://forum.cfx.re/login' })
  ;(resolveAssetId as jest.Mock).mockResolvedValue('7')
  ;(findAssetId as jest.Mock).mockResolvedValue(undefined)
  post = jest.spyOn(axios, 'post').mockImplementation(
    async (url: string) =>
      await Promise.resolve({
        data: url.endsWith('/re-upload')
          ? { asset_id: 7, version_id: 102, errors: null }
          : {}
      })
  )
})

test('creates a missing asset with the Portal version-scoped upload flow', async () => {
  inputs.createIfMissing = 'true'
  inputs.assetVersion = '2.0.0'
  inputs.deploy = 'false'
  post.mockImplementation(
    async (url: string) =>
      ({
        data: url.endsWith('/me/assets') ? { asset_id: 19, version_id: 42 } : {}
      }) as any
  )
  await run()
  expect(core.setFailed).not.toHaveBeenCalled()
  expect(post).toHaveBeenCalledWith(
    'https://portal-api.cfx.re/v1/me/assets',
    expect.objectContaining({ name: 'sa_garage', version: '2.0.0' }),
    expect.any(Object)
  )
  expect(post).toHaveBeenCalledWith(
    'https://portal-api.cfx.re/v1/assets/19/versions/42/complete-upload',
    {},
    expect.any(Object)
  )
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
  jest.restoreAllMocks()
})

test('invalid chunk size fails without uploading and closes the mocked browser', async () => {
  inputs.chunkSize = 'invalid'
  await run()
  expect(core.setFailed).toHaveBeenCalledWith(
    'Invalid chunk size. Must be a number.'
  )
  expect(post).not.toHaveBeenCalled()
  expect(browser.close).toHaveBeenCalled()
})

test('single ZIP upload passes its returned version identity into deployment', async () => {
  await run()
  expect(preparePuppeteer).toHaveBeenCalled()
  expect(page.goto).toHaveBeenCalledWith(
    'https://portal-api.cfx.re/v1/auth/discourse?return=',
    {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }
  )
  expect(core.setFailed).not.toHaveBeenCalled()
  expect(post).toHaveBeenCalledWith(
    expect.stringContaining('/assets/7/complete-upload'),
    {},
    expect.any(Object)
  )
  expect(deployAsset).toHaveBeenCalledWith(
    '',
    'sa_garage',
    expect.objectContaining({ enabled: true }),
    { assetId: 7, versionId: 102 }
  )
  expect(browser.close).toHaveBeenCalled()
})

test('missing version ID prevents chunk upload and deployment', async () => {
  post.mockResolvedValue({
    data: { asset_id: 7, errors: null }
  })
  await run()
  expect(core.setFailed).toHaveBeenCalledWith(
    expect.stringContaining('version_id')
  )
  expect(post).toHaveBeenCalledTimes(1)
  expect(deployAsset).not.toHaveBeenCalled()
})
