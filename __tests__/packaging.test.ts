import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { pipeline } from 'stream/promises'
import yazl from 'yazl'
import { writeResourceZip } from '../src/packaging/archive'
import { inspectResourceZip, verifyWebFiles } from '../src/packaging/inspect'
import { listFiles } from '../src/packaging/paths'
import { readReleaseVersion, setRunVersion } from '../src/release-version'

let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-packaging-'))
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

function fixture(): string {
  const root = path.join(directory, 'source')
  fs.mkdirSync(root)
  fs.writeFileSync(
    path.join(root, 'fxmanifest.lua'),
    "fx_version 'cerulean'\nversion '1.0.0'\n"
  )
  fs.writeFileSync(path.join(root, 'server.lua'), 'print("hello")')
  fs.writeFileSync(path.join(root, 'README.md'), 'development only')
  return root
}

test('sets run version without modifying any other manifest declarations', () => {
  const manifest = "fx_version 'cerulean'\nversion '3.2.4'\ngame 'gta5'\n"
  expect(setRunVersion(manifest, '42', '2')).toEqual({
    manifest: "fx_version 'cerulean'\nversion '3.42.2'\ngame 'gta5'\n",
    version: '3.42.2'
  })
  for (const input of [
    '',
    "version '1.0.0'\nversion '2.0.0'",
    "version 'bad'",
    "version '1.0.0'\nversion 'bad'"
  ]) {
    expect(() => readReleaseVersion(input)).toThrow()
  }
  expect(() => setRunVersion(manifest, '1', '0')).toThrow()
})

test('writes selected runtime files under the resource root and verifies their bytes', async () => {
  const source = fixture()
  const selected = ['fxmanifest.lua', 'server.lua']
  const zipPath = await writeResourceZip(
    source,
    path.join(directory, 'release.zip'),
    'garage',
    selected
  )
  const result = await inspectResourceZip(zipPath, 'garage')
  expect(result.version).toBe('1.0.0')
  expect(result.files).toEqual(['garage/fxmanifest.lua', 'garage/server.lua'])
  for (const file of selected) {
    expect(result.hashes[`garage/${file}`]).toBe(
      createHash('sha256')
        .update(fs.readFileSync(path.join(source, file)))
        .digest('hex')
    )
  }
  expect(fs.readFileSync(path.join(source, 'README.md'), 'utf8')).toBe(
    'development only'
  )
})

test('rejects links, directory escapes and output-as-input before writing', async () => {
  const source = fixture()
  fs.symlinkSync(
    path.join(source, 'server.lua'),
    path.join(source, 'linked.lua')
  )
  expect(() => listFiles(source)).toThrow('Symlink')
  await expect(
    writeResourceZip(source, path.join(directory, 'out.zip'), 'garage', [
      'linked.lua'
    ])
  ).rejects.toThrow('Symlink')
  await expect(
    writeResourceZip(source, path.join(directory, 'out.zip'), 'garage', [
      '../outside'
    ])
  ).rejects.toThrow('Invalid relative path')
  await expect(
    writeResourceZip(source, path.join(source, 'server.lua'), 'garage', [
      'server.lua'
    ])
  ).rejects.toThrow('input files')
})

test('rejects archives with a different root, duplicate entries or symbolic links', async () => {
  const source = fixture()
  const zipPath = await writeResourceZip(
    source,
    path.join(directory, 'wrong.zip'),
    'other',
    ['fxmanifest.lua']
  )
  await expect(inspectResourceZip(zipPath, 'garage')).rejects.toThrow('root')
  for (const type of ['duplicate', 'symlink']) {
    const archive = new yazl.ZipFile()
    archive.addBuffer(Buffer.from("version '1.0.0'"), 'garage/fxmanifest.lua')
    archive.addBuffer(
      Buffer.from('target'),
      type === 'duplicate' ? 'garage/fxmanifest.lua' : 'garage/link',
      type === 'symlink' ? { mode: 0o120777 } : {}
    )
    const target = path.join(directory, `${type}.zip`)
    const writing = pipeline(archive.outputStream, fs.createWriteStream(target))
    archive.end()
    await writing
    await expect(inspectResourceZip(target, 'garage')).rejects.toThrow()
  }
})

test('web checks are opt-in and require index, JavaScript and CSS', () => {
  expect(() => verifyWebFiles([], 'garage', '')).not.toThrow()
  expect(() =>
    verifyWebFiles(['garage/web/build/index.html'], 'garage', 'web/build')
  ).toThrow()
  expect(() =>
    verifyWebFiles(
      [
        'garage/web/build/index.html',
        'garage/web/build/assets/app.js',
        'garage/web/build/assets/app.css'
      ],
      'garage',
      'web/build'
    )
  ).not.toThrow()
})

test('adds a run version only when the manifest has no version declaration', () => {
  const manifest = "fx_version 'cerulean'\ngame 'gta5'\n"
  expect(setRunVersion(manifest, '42', '2')).toEqual({
    manifest: manifest + "version '1.42.2'\n",
    version: '1.42.2'
  })
  expect(() => setRunVersion("version 'invalid'", '42', '2')).toThrow()
  expect(() =>
    setRunVersion("version '1.0.0'\nversion '2.0.0'", '42', '2')
  ).toThrow()
})
