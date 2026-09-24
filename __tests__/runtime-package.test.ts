import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import {
  manifestReferences,
  selectRuntimeFiles
} from '../src/packaging/manifest'
import {
  createRuntimePackage,
  inspectRuntimeTar
} from '../src/packaging/runtime'
import { inspectResourceZip } from '../src/packaging/inspect'

let directory: string
let root: string
const originalTemp = process.env.RUNNER_TEMP
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-runtime-test-'))
  root = path.join(directory, 'source')
  fs.mkdirSync(root)
  process.env.RUNNER_TEMP = directory
})
afterEach(() => {
  if (originalTemp === undefined) delete process.env.RUNNER_TEMP
  else process.env.RUNNER_TEMP = originalTemp
  fs.rmSync(directory, { recursive: true, force: true })
})
function write(file: string, content = 'runtime data'): void {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}
function manifest(content: string): void {
  write(
    'fxmanifest.lua',
    `fx_version 'cerulean'\ngame 'gta5'\nversion '1.2.3'\n${content}`
  )
}

test('parses Lua declarations, tables, constants and chained data_file calls without executing Lua', () => {
  expect(
    manifestReferences(`
    -- client_script 'not-real.lua'
    description "server_script 'not-real-either.lua'"
    local folder = 'client/'
    local shared = {'shared/config.lua', '@ox_lib/init.lua'}
    client_scripts { folder .. '**.lua', [=[client/árvíz.lua]=] }
    shared_scripts(shared)
    files {'web/build/**'}
    ui_page 'web/build/index.html'
    data_file 'HANDLING_FILE' 'data/*.meta'
    escrow_ignore {'not-an-inclusion-rule.lua'}
    dependency 'other-resource'
    ui_page 'https://example.invalid/ui'
  `)
  ).toEqual([
    'client/**.lua',
    'client/árvíz.lua',
    'shared/config.lua',
    'web/build/**',
    'web/build/index.html',
    'data/*.meta'
  ])
})

test('selects runtime files and the two SQL files while excluding development content', () => {
  manifest(
    "client_scripts {'client/**.lua'}\nshared_script 'shared/config.lua'\nfiles {'web/build/**/*'}\nui_page 'web/build/index.html'"
  )
  for (const file of [
    'client/main.lua',
    'client/nested/util.lua',
    'shared/config.lua',
    'web/build/index.html',
    'web/build/assets/app.js',
    'web/build/assets/app.css',
    'install/schema.sql',
    'install/seed.sql'
  ])
    write(file)
  for (const file of [
    'README.md',
    'web/src/App.tsx',
    'web/build/assets/app.js.map',
    'node_modules/pkg/index.js',
    'tests/run.lua',
    'package.json',
    'install/notes.txt'
  ])
    write(file)
  expect(selectRuntimeFiles(root, 'web/build')).toEqual([
    'client/main.lua',
    'client/nested/util.lua',
    'fxmanifest.lua',
    'install/schema.sql',
    'install/seed.sql',
    'shared/config.lua',
    'web/build/assets/app.css',
    'web/build/assets/app.js',
    'web/build/index.html'
  ])
})

test('SQL files are optional and stream assets are preserved without explicit file directives', () => {
  manifest("this_is_a_map 'yes'\nshared_script '@external/init.lua'")
  write('stream/map.ymap')
  write('stream/map.ytyp')
  expect(selectRuntimeFiles(root)).toEqual([
    'fxmanifest.lua',
    'stream/map.ymap',
    'stream/map.ytyp'
  ])
})

test('resolves data_file directories and CFX recursive glob syntax', () => {
  manifest("data_file 'AUDIO_WAVEPACK' 'audio/waves'\nserver_script '**.lua'")
  write('audio/waves/sample.awc')
  write('server/deep/main.lua')
  expect(selectRuntimeFiles(root)).toContain('audio/waves/sample.awc')
  expect(selectRuntimeFiles(root)).toContain('server/deep/main.lua')
})

test.each([
  "server_script '../outside.lua'",
  "file '/etc/passwd'",
  "file 'README.md'",
  "client_script 'missing/*.lua'"
])('rejects unsafe, forbidden or missing references: %s', declaration => {
  manifest(declaration)
  write('README.md')
  expect(() => selectRuntimeFiles(root)).toThrow()
})

test.each([
  "if true then client_script 'client.lua' end",
  'client_scripts getFiles()',
  "local f = os.execute('anything')\nclient_script f"
])(
  'rejects dynamic manifests rather than silently dropping their files: %s',
  declaration => {
    expect(() => manifestReferences(declaration)).toThrow()
  }
)

test('rejects symlinked SQL files instead of following them', () => {
  manifest('')
  write('outside.sql')
  fs.mkdirSync(path.join(root, 'install'))
  fs.symlinkSync(
    path.join(root, 'outside.sql'),
    path.join(root, 'install/schema.sql')
  )
  expect(() => selectRuntimeFiles(root)).toThrow('Symlink')
})

test('packages ZIP and TAR with exactly the same runtime files and original bytes', async () => {
  manifest("server_script 'server.lua'")
  write('server.lua', 'print("server")')
  write('install/schema.sql', 'CREATE TABLE example (id INTEGER);')
  write('README.md', 'must not ship')
  const built = await createRuntimePackage(root, 'different_resource')
  const inspected = await inspectResourceZip(
    built.zipPath,
    'different_resource'
  )
  const tarHashes = await inspectRuntimeTar(
    path.join(built.directory, 'different_resource.tar.gz')
  )
  expect(inspected.files).toEqual([
    'different_resource/fxmanifest.lua',
    'different_resource/install/schema.sql',
    'different_resource/server.lua'
  ])
  expect(tarHashes).toEqual(inspected.hashes)
  for (const name of inspected.files) {
    const relative = name.slice('different_resource/'.length)
    expect(inspected.hashes[name]).toBe(
      createHash('sha256')
        .update(fs.readFileSync(path.join(root, relative)))
        .digest('hex')
    )
  }
  expect(fs.existsSync(path.join(built.directory, 'staging'))).toBe(false)
  expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(
    'must not ship'
  )
})

test('ignores nested development dependencies, including their symlinks', () => {
  manifest("file 'web/build/index.html'")
  write('web/build/index.html')
  write('web/node_modules/pkg/index.js')
  fs.symlinkSync(
    '/missing-development-dependency',
    path.join(root, 'web/node_modules/link')
  )
  expect(selectRuntimeFiles(root)).toEqual([
    'fxmanifest.lua',
    'web/build/index.html'
  ])
})
