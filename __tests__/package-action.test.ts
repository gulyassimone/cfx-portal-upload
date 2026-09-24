import * as core from '@actions/core'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { runPackage } from '../src/packaging/action'
import { writeResourceZip } from '../src/packaging/archive'

let directory: string
let workspace: string
let inputs: Record<string, string>
let outputs: Record<string, string>
const originalEnv = { ...process.env }

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-package-action-'))
  workspace = path.join(directory, 'resource')
  fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(workspace, 'fxmanifest.lua'), "version '2.0.0'\n")
  fs.writeFileSync(path.join(workspace, 'server.lua'), 'print("runtime")')
  process.env.GITHUB_WORKSPACE = workspace
  process.env.RUNNER_TEMP = directory
  process.env.GITHUB_RUN_NUMBER = '12'
  process.env.GITHUB_RUN_ATTEMPT = '3'
  process.env.GITHUB_SHA = 'a'.repeat(40)
  inputs = { operation: 'prepare', 'resource-name': 'example' }
  outputs = {}
  jest.spyOn(core, 'getInput').mockImplementation(name => inputs[name] || '')
  jest.spyOn(core, 'setOutput').mockImplementation((name, value: unknown) => {
    outputs[name] = String(value)
  })
  jest.spyOn(core, 'info').mockImplementation(() => {})
})
afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...originalEnv }
  fs.rmSync(directory, { recursive: true, force: true })
})

test('prepares, collects and inspects a web-less release with exact ZIP identity', async () => {
  await runPackage()
  expect(outputs.version).toBe('2.12.3')
  inputs['zip-path'] = 'dist/example.zip'
  await writeResourceZip(
    workspace,
    path.join(workspace, inputs['zip-path']),
    'example',
    ['fxmanifest.lua', 'server.lua']
  )
  const original = fs.readFileSync(path.join(workspace, inputs['zip-path']))
  inputs.operation = 'collect'
  inputs['expected-version'] = outputs.version
  await runPackage()
  const collected = outputs['artifact-directory']
  expect(fs.readFileSync(path.join(collected, 'example-release.zip'))).toEqual(
    original
  )
  expect(
    fs.readFileSync(
      path.join(collected, 'example-release.metadata.json'),
      'utf8'
    )
  ).toContain(process.env.GITHUB_SHA)
  expect(fs.readFileSync(path.join(collected, 'contents.txt'), 'utf8')).toBe(
    'example/fxmanifest.lua\nexample/server.lua\n'
  )
  inputs.operation = 'inspect'
  inputs['expected-sha256'] = outputs.sha256
  await runPackage()
  inputs['expected-sha256'] = 'b'.repeat(64)
  await expect(runPackage()).rejects.toThrow('SHA-256')
  inputs['expected-version'] = '9.9.9'
  await expect(runPackage()).rejects.toThrow('version')
})

test('fails when requested web build is absent rather than building it', async () => {
  inputs['web-build-path'] = 'web/build'
  await expect(runPackage()).rejects.toThrow()
  expect(fs.existsSync(path.join(workspace, 'web'))).toBe(false)
})

test('runtime operation builds from the manifest, includes SQL and writes provenance', async () => {
  fs.appendFileSync(
    path.join(workspace, 'fxmanifest.lua'),
    "server_script 'server.lua'\n"
  )
  fs.mkdirSync(path.join(workspace, 'install'))
  fs.writeFileSync(path.join(workspace, 'install/schema.sql'), 'schema')
  await runPackage()
  inputs['expected-version'] = outputs.version
  inputs.operation = 'package'
  await runPackage()
  const collected = outputs['artifact-directory']
  expect(fs.existsSync(path.join(collected, 'example-release.zip'))).toBe(true)
  expect(fs.existsSync(path.join(collected, 'example.tar.gz'))).toBe(true)
  expect(
    fs.readFileSync(path.join(collected, 'contents.txt'), 'utf8')
  ).toContain('example/install/schema.sql')
  expect(
    fs.readFileSync(
      path.join(collected, 'example-release.metadata.json'),
      'utf8'
    )
  ).toContain('"encrypted": false')
})
