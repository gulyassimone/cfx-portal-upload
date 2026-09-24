import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runtimeFiles } from '../src/runtime-package'

let workspace: string

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-runtime-'))
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  const write = (file: string, content = 'test'): void => {
    const absolute = path.join(workspace, file)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  write('fxmanifest.lua')
  write('client/main.lua')
  write('README.md')
  write('web/src/App.tsx')
  write('web/package.json')
  write('tests/spec.lua')
  write('web/build/index.html')
  write('web/build/assets/app.js')
  execFileSync('git', ['add', '.'], { cwd: workspace })
  write('web/build/assets/new.css')
  write('node_modules/secret.txt')
})

afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }))

test('includes tracked resource files and built assets without development files', () => {
  expect(runtimeFiles(workspace)).toEqual([
    'client/main.lua',
    'fxmanifest.lua',
    'web/build/assets/app.js',
    'web/build/assets/new.css',
    'web/build/index.html'
  ])
})
