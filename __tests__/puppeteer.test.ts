import fs from 'fs'
import { install, Browser } from '@puppeteer/browsers'
import { preparePuppeteer } from '../src/utils'

jest.mock('@puppeteer/browsers', () => ({
  Browser: { CHROME: 'chrome' },
  install: jest.fn()
}))
jest.mock('puppeteer', () => ({
  __esModule: true,
  default: { browserVersion: '131.0.6778.108' }
}))

const originalEnv = { ...process.env }
beforeEach(() => {
  delete process.env.PUPPETEER_EXECUTABLE_PATH
  delete process.env.CHROME_BIN
  delete process.env.RUNNER_TEMP
  process.env.PUPPETEER_CACHE_DIR = '/test/cache'
  jest.spyOn(fs, 'accessSync').mockImplementation(() => undefined)
})
afterEach(() => {
  process.env = { ...originalEnv }
  jest.restoreAllMocks()
  jest.resetAllMocks()
})

test('installs the required revision and returns its actual path without RUNNER_TEMP', async () => {
  jest
    .mocked(install)
    .mockResolvedValue({ executablePath: '/test/chrome' } as unknown as Awaited<
      ReturnType<typeof install>
    >)
  await expect(preparePuppeteer()).resolves.toBe('/test/chrome')
  expect(install).toHaveBeenCalledWith({
    cacheDir: '/test/cache',
    browser: Browser.CHROME,
    buildId: '131.0.6778.108'
  })
})
test('uses an explicit executable without downloading', async () => {
  process.env.CHROME_BIN = '/custom/chrome'
  await expect(preparePuppeteer()).resolves.toBe('/custom/chrome')
  expect(install).not.toHaveBeenCalled()
})
test('propagates installation failures instead of continuing', async () => {
  jest.mocked(install).mockRejectedValue(new Error('download failed'))
  await expect(preparePuppeteer()).rejects.toThrow('download failed')
})
test('rejects a missing explicitly configured executable', async () => {
  process.env.CHROME_BIN = '/missing/chrome'
  jest.mocked(fs.accessSync).mockImplementation(() => {
    throw new Error('ENOENT')
  })
  await expect(preparePuppeteer()).rejects.toThrow('ENOENT')
  expect(install).not.toHaveBeenCalled()
})
