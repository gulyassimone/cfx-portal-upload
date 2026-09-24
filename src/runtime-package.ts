import * as core from '@actions/core'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import yazl from 'yazl'

const EXCLUDED_DIRS = new Set([
  '.git',
  '.github',
  '.vscode',
  '.idea',
  'node_modules',
  'tests',
  '__tests__',
  'e2e',
  'docs',
  'coverage',
  'escrowed',
  'open-source'
])
const BUILD_DIRS = ['web/build', 'web/dist', 'html/static']
const BUILD_FILES = ['html/index.html']

function includeRuntimeFile(relativePath: string): boolean {
  const parts = relativePath.split('/')
  const name = parts[parts.length - 1]
  if (parts.some(part => EXCLUDED_DIRS.has(part)) || parts[0] === 'dist')
    return false
  if (parts.some(part => part.startsWith('.') && part !== '.fxap')) return false
  if (
    parts.length > 1 &&
    ['web', 'html'].includes(parts[0]) &&
    ['src', 'scripts', 'e2e', 'node_modules'].includes(parts[1])
  )
    return false
  if (/^(readme|license|changelog|contributing)(\.|$)/i.test(name)) return false
  if (
    /^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig.*\.json|vite\.config\..*|jest\.config\..*)$/i.test(
      name
    )
  )
    return false
  if (/\.(map|ts|tsx|md|zip|rar|7z|tar|gz)$/i.test(name)) return false
  return true
}

export function runtimeFiles(workspace: string): string[] {
  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: workspace,
    encoding: 'utf8'
  })
    .split('\0')
    .filter(Boolean)
  const files = new Set(tracked.filter(includeRuntimeFile))
  for (const directory of BUILD_DIRS) {
    const absolute = path.join(workspace, directory)
    if (!fs.existsSync(absolute)) continue
    const visit = (folder: string): void => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const fullPath = path.join(folder, entry.name)
        if (entry.isDirectory()) visit(fullPath)
        else if (entry.isFile()) {
          const relative = path
            .relative(workspace, fullPath)
            .replaceAll(path.sep, '/')
          if (includeRuntimeFile(relative)) files.add(relative)
        }
      }
    }
    visit(absolute)
  }
  for (const file of BUILD_FILES) {
    if (fs.existsSync(path.join(workspace, file))) files.add(file)
  }
  return [...files]
    .filter(file => {
      const absolute = path.join(workspace, file)
      return (
        fs.existsSync(absolute) &&
        fs.statSync(absolute).isFile() &&
        fs.realpathSync(absolute) === absolute
      )
    })
    .sort()
}

export async function zipRuntimeAsset(
  assetName: string,
  workspace: string
): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(assetName)) {
    throw new Error('Runtime ZIP asset name must be a simple resource name')
  }
  const files = runtimeFiles(workspace)
  if (!files.includes('fxmanifest.lua')) {
    throw new Error('Runtime ZIP requires fxmanifest.lua')
  }
  const outputPath = path.resolve(`${assetName}.zip`)
  const zip = new yazl.ZipFile()
  for (const file of files)
    zip.addFile(path.join(workspace, file), `${assetName}/${file}`)
  zip.end()
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(outputPath)
    zip.outputStream.on('error', reject)
    stream.on('error', reject)
    stream.on('close', resolve)
    zip.outputStream.pipe(stream)
  })
  core.info(`Packaged ${files.length} runtime files in ${outputPath}`)
  return outputPath
}
