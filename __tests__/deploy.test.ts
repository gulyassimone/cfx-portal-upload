import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as core from '@actions/core'
import { Client } from 'ssh2'
import { deployToServer } from '../src/deploy'

jest.mock('ssh2', () => {
  const { EventEmitter } = jest.requireActual<typeof import('events')>('events')
  return {
    Client: jest.fn().mockImplementation(() => {
      const client = new EventEmitter()
      return Object.assign(client, {
        connect: jest.fn(() => client.emit('ready')),
        end: jest.fn(),
        sftp: (callback: (error: null, sftp: object) => void) =>
          callback(null, {
            writeFile: (_path: string, _data: Buffer, done: () => void) =>
              done()
          }),
        exec: jest.fn(
          (
            command: string,
            callback: (error: null, stream: object) => void
          ) => {
            const stream = Object.assign(new EventEmitter(), {
              stderr: new EventEmitter()
            })
            callback(null, stream)
            queueMicrotask(() => stream.emit('close', 0))
          }
        )
      })
    })
  }
})

let root: string
let resource: string
let backups: string
let bin: string

beforeEach(() => {
  jest.spyOn(core, 'info').mockImplementation(() => {})
  root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy test's-"))
  resource = path.join(root, 'resources', 'my-resource')
  backups = path.join(root, 'backups')
  bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  // Stand in for extraction, checking that deletion happened before unzip.
  fs.writeFileSync(
    path.join(bin, 'unzip'),
    '#!/bin/sh\n[ ! -e "$TEST_RESOURCE" ] || exit 9\nmkdir -p "$TEST_RESOURCE" && echo new > "$TEST_RESOURCE/current.txt"\n',
    { mode: 0o755 }
  )
})

afterEach(() => {
  jest.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

async function runDeployment(): Promise<number | null> {
  const zip = path.join(root, `${path.basename(root)}.zip`)
  fs.writeFileSync(zip, 'test archive')
  await deployToServer(
    { host: 'test', port: 22, username: 'test', privateKey: 'test' },
    path.dirname(resource),
    zip,
    path.basename(resource),
    backups
  )
  const client = jest.mocked(Client).mock.results[0].value as Client
  const command = jest.mocked(client).exec.mock.calls[0][0]
  return spawnSync('/bin/sh', ['-c', command], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_RESOURCE: resource
    }
  }).status
}

test('backs up all old files, removes the directory, then extracts the release', async () => {
  fs.mkdirSync(resource, { recursive: true })
  fs.writeFileSync(path.join(resource, 'obsolete.txt'), 'old')
  fs.writeFileSync(path.join(resource, '.hidden'), 'hidden')
  const sibling = path.join(path.dirname(resource), 'other-resource')
  fs.mkdirSync(sibling)
  fs.writeFileSync(path.join(sibling, 'keep.txt'), 'keep')

  expect(await runDeployment()).toBe(0)
  const snapshot = path.join(
    backups,
    'my-resource',
    fs.readdirSync(path.join(backups, 'my-resource'))[0]
  )
  expect(fs.readFileSync(path.join(snapshot, 'obsolete.txt'), 'utf8')).toBe(
    'old'
  )
  expect(fs.readFileSync(path.join(snapshot, '.hidden'), 'utf8')).toBe('hidden')
  expect(fs.readdirSync(resource)).toEqual(['current.txt'])
  expect(fs.readFileSync(path.join(sibling, 'keep.txt'), 'utf8')).toBe('keep')
})

test('keeps the existing directory and skips extraction if backup fails', async () => {
  fs.mkdirSync(resource, { recursive: true })
  fs.writeFileSync(path.join(resource, 'obsolete.txt'), 'old')
  fs.writeFileSync(path.join(bin, 'cp'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

  expect(await runDeployment()).toBe(1)
  expect(fs.readdirSync(resource)).toEqual(['obsolete.txt'])
  expect(fs.readFileSync(path.join(resource, 'obsolete.txt'), 'utf8')).toBe(
    'old'
  )
})

test('installs when the resource directory does not yet exist', async () => {
  expect(await runDeployment()).toBe(0)
  expect(fs.readdirSync(resource)).toEqual(['current.txt'])
})
