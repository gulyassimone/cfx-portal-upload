import { Browser, install } from '@puppeteer/browsers'
import puppeteer from 'puppeteer'
import {
  SearchResponse,
  Urls,
  BuildOptions,
  ZipPaths,
  VersionConfig
} from './types'
import { homedir } from 'os'
import { join } from 'path'

import * as core from '@actions/core'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import yazl from 'yazl'

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Get resource name from resourcePath or repository name
 * @param resourcePath Optional path to resource folder
 * @returns Resource name (folder name)
 */
export function getResourceName(resourcePath?: string): string {
  // If resourcePath is specified, use the folder name from it
  if (resourcePath) {
    return path.basename(resourcePath)
  }

  // Otherwise use repository name from GITHUB_REPOSITORY (format: owner/repo-name)
  const repo = process.env.GITHUB_REPOSITORY
  if (repo) {
    return repo.split('/').pop() || repo
  }

  // Fallback to workspace folder name
  const workspace = process.env.GITHUB_WORKSPACE
  if (workspace) {
    return path.basename(workspace)
  }

  return 'resource'
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Directories to exclude when copying workspace */
const EXCLUDE_DIRS = [
  '.git',
  '.github',
  '.vscode',
  'node_modules',
  'escrowed',
  'open-source'
]

/** File extensions that are considered archives and should be excluded */
const ARCHIVE_EXTENSIONS = [
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz'
]

// ============================================================================
// LOW-LEVEL UTILITIES
// ============================================================================

/**
 * Check if a file is an archive based on its extension
 * @param filename The filename to check
 * @returns true if the file is an archive
 */
function isArchive(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase()
  return ARCHIVE_EXTENSIONS.includes(ext)
}

/**
 * Creates directory recursively if it doesn't exist
 * @param dirPath Path to directory
 */
function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

/**
 * Copies files and directories recursively with filtering
 * @param src Source path
 * @param dest Destination path
 * @param excludeDirs Directories to exclude
 * @param excludeArchives Whether to exclude archive files
 */
function copyRecursivelyFiltered(
  src: string,
  dest: string,
  excludeDirs: string[] = [],
  excludeArchives: boolean = true
): void {
  const stats = fs.statSync(src)

  if (stats.isDirectory()) {
    if (excludeDirs.includes(path.basename(src))) {
      return
    }

    ensureDirectory(dest)

    const entries = fs.readdirSync(src)
    for (const entry of entries) {
      if (excludeDirs.includes(entry)) {
        continue
      }
      if (excludeArchives && isArchive(entry)) {
        core.debug(`Skipping archive file: ${entry}`)
        continue
      }
      copyRecursivelyFiltered(
        path.join(src, entry),
        path.join(dest, entry),
        excludeDirs,
        excludeArchives
      )
    }
  } else if (stats.isFile()) {
    if (excludeArchives && isArchive(path.basename(src))) {
      core.debug(`Skipping archive file: ${src}`)
      return
    }
    fs.copyFileSync(src, dest)
  }
}

/**
 * Copies workspace to destination directory, excluding system dirs and archives
 * @param destDir Destination directory path
 * @param resourcePath Optional subdirectory within workspace to copy from
 */
function copyWorkspaceToDir(destDir: string, resourcePath?: string): void {
  const workspacePath = getEnv('GITHUB_WORKSPACE')
  const sourcePath = resourcePath
    ? path.join(workspacePath, resourcePath)
    : workspacePath
  ensureDirectory(destDir)

  const entries = fs.readdirSync(sourcePath)
  for (const entry of entries) {
    if (EXCLUDE_DIRS.includes(entry)) {
      continue
    }
    if (isArchive(entry)) {
      core.debug(`Skipping archive file: ${entry}`)
      continue
    }

    const srcPath = path.join(sourcePath, entry)
    const destPath = path.join(destDir, entry)
    const stats = fs.statSync(srcPath)

    if (stats.isDirectory()) {
      copyRecursivelyFiltered(srcPath, destPath, ['node_modules'], true)
    } else if (stats.isFile()) {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// ============================================================================
// FXMANIFEST UTILITIES
// ============================================================================

/**
 * Replaces or appends escrow_ignore block in fxmanifest.lua
 * @param fxmanifestPath Path to fxmanifest.lua
 * @param files Array of files/patterns to ignore
 * @param forceReplace If true, replaces existing escrow_ignore; if false, only adds if not present
 */
function setEscrowIgnore(
  fxmanifestPath: string,
  files: string[],
  forceReplace: boolean = false
): void {
  if (!fs.existsSync(fxmanifestPath)) {
    return
  }

  let content = fs.readFileSync(fxmanifestPath, 'utf8')
  const ignoreEntries = files.map(file => `  '${file}',`).join('\n')
  const escrowIgnoreBlock = `escrow_ignore {\n${ignoreEntries}\n}`

  // Check if escrow_ignore already exists
  const escrowIgnoreRegex = /^\s*escrow_ignore\s*\{[^}]*\}/m

  if (escrowIgnoreRegex.test(content)) {
    if (forceReplace) {
      // Replace existing escrow_ignore
      content = content.replace(escrowIgnoreRegex, escrowIgnoreBlock)
      fs.writeFileSync(fxmanifestPath, content, 'utf8')
      core.info('Replaced existing escrow_ignore in fxmanifest.lua')
    } else {
      // Keep existing escrow_ignore
      core.info('Keeping existing escrow_ignore from fxmanifest.lua')
    }
  } else {
    // Append new escrow_ignore
    fs.appendFileSync(fxmanifestPath, `\n${escrowIgnoreBlock}\n`)
    core.info('Added escrow_ignore to fxmanifest.lua')
  }
}

/**
 * Updates fxmanifest.lua version field ONLY if running from a git tag
 * All other fields (name, description, author) are left unchanged - author controls them
 * @param fxmanifestPath Path to fxmanifest.lua file
 */
function updateFxManifestVersion(fxmanifestPath: string): void {
  if (!fs.existsSync(fxmanifestPath)) {
    return
  }

  // Only update version if this is a tag (not a branch)
  const refType = process.env.GITHUB_REF_TYPE
  if (refType !== 'tag') {
    core.info('No git tag found, keeping original version in fxmanifest.lua')
    return
  }

  const tagName = process.env.GITHUB_REF_NAME
  if (!tagName) {
    core.info('No tag name found, keeping original version')
    return
  }

  // Remove 'v' prefix if present (v1.2.3 -> 1.2.3)
  const version = tagName.replace(/^v/, '')

  let content = fs.readFileSync(fxmanifestPath, 'utf8')
  const versionRegex = /^(\s*version\s+)(['"`])([^'"`]*)(['"`])/m

  if (versionRegex.test(content)) {
    content = content.replace(versionRegex, `$1'${version}'`)
    fs.writeFileSync(fxmanifestPath, content, 'utf8')
    core.info(`Updated fxmanifest.lua version to '${version}'`)
  } else {
    // Add version after fx_version if it doesn't exist
    const fxVersionRegex = /^(\s*fx_version\s+[^\n]*\n)/m
    if (fxVersionRegex.test(content)) {
      content = content.replace(fxVersionRegex, `$1version '${version}'\n`)
      fs.writeFileSync(fxmanifestPath, content, 'utf8')
      core.info(`Added version '${version}' to fxmanifest.lua`)
    }
  }
}

// ============================================================================
// VERSION CREATION
// ============================================================================

/**
 * Creates a resource version (escrowed or opensource)
 * @param config Version configuration
 * @returns Path to the created ZIP file
 */
async function createResourceVersion(config: VersionConfig): Promise<string> {
  const { type, resourcePath } = config
  const workspacePath = getEnv('GITHUB_WORKSPACE')

  // Get resource name from resourcePath or repository name
  const resourceName = getResourceName(resourcePath)

  const dirName = type === 'escrowed' ? 'escrowed' : 'open-source'
  const targetDir = path.join(workspacePath, dirName)
  const zipSuffix = type === 'escrowed' ? 'escrowed' : 'opensource'

  core.info(`Creating ${type} version...`)
  core.info(`Resource name: ${resourceName}`)
  if (resourcePath) {
    core.info(`Using resource path: ${resourcePath}`)
  }

  // Build web/dui if exists
  await buildWebAndDui(resourcePath)

  // Copy source to target directory
  copyWorkspaceToDir(targetDir, resourcePath)

  // Update fxmanifest.lua version (only if git tag exists)
  const fxmanifestPath = path.join(targetDir, 'fxmanifest.lua')
  updateFxManifestVersion(fxmanifestPath)

  // Handle escrow_ignore based on type
  if (type === 'opensource') {
    // For opensource: always set escrow_ignore to '**/*' (all files open)
    setEscrowIgnore(fxmanifestPath, ['**/*'], true)
  }
  // For escrowed: don't touch escrow_ignore - author controls it in fxmanifest.lua

  // Create ZIP
  const zipPath = `${resourceName}.${zipSuffix}.zip`
  return await zipDirectory(targetDir, zipPath, resourceName)
}

// ============================================================================
// PUPPETEER SETUP
// ============================================================================

/**
 * Get the cache directory for Puppeteer.
 * @returns {string} The cache directory.
 */
function getCacheDirectory(): string {
  return (
    process.env.PUPPETEER_CACHE_DIR || join(homedir(), '.cache', 'puppeteer')
  )
}

/** Install the exact Chrome revision required by Puppeteer and return its path. */
export async function preparePuppeteer(): Promise<string> {
  const explicitPath =
    process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN
  if (explicitPath) {
    fs.accessSync(explicitPath, fs.constants.X_OK)
    return explicitPath
  }

  // Puppeteer 23 exposes this at runtime but omits it from its public types.
  const buildId = (puppeteer as unknown as { browserVersion: string })
    .browserVersion
  if (!buildId || !/^\d+\.\d+\.\d+\.\d+$/.test(buildId)) {
    throw new Error('Cannot determine the Chrome version required by Puppeteer')
  }
  core.info(`Preparing Puppeteer Chrome ${buildId}`)
  // install() reuses this exact build if already present in the cache.
  // Fail immediately on download errors instead of launching a missing browser.
  const browser = await install({
    cacheDir: getCacheDirectory(),
    browser: Browser.CHROME,
    buildId
  })
  fs.accessSync(browser.executablePath, fs.constants.X_OK)
  return browser.executablePath
}

export async function resolveAssetId(
  name: string,
  cookies: string
): Promise<string> {
  core.info(`🔍 Searching for asset: "${name}"`)

  try {
    const search = await axios.get<SearchResponse>(
      `https://portal-api.cfx.re/v1/me/assets?search=${encodeURIComponent(name)}&sort=asset.name&direction=asc`,
      {
        headers: {
          Cookie: cookies
        }
      }
    )

    core.info(`📊 Found ${search.data.items.length} assets matching search`)

    if (search.data.items.length == 0) {
      core.info(`🆕 Asset "${name}" does not exist; creating it...`)
      const created = await axios.post<
        { id?: unknown; asset_id?: unknown; asset?: { id?: unknown } }
      >(
        'https://portal-api.cfx.re/v1/me/assets',
        { name },
        { headers: { Cookie: cookies } }
      )
      const createdId =
        created.data.id ?? created.data.asset_id ?? created.data.asset?.id

      if (
        typeof createdId !== 'number' ||
        !Number.isSafeInteger(createdId) ||
        createdId <= 0
      ) {
        throw new Error(
          `CFX Portal returned an invalid asset ID while creating "${name}".`
        )
      }

      core.info(`✅ Created asset: "${name}" (ID: ${createdId})`)
      return createdId.toString()
    }

    core.info('📋 Available assets:')
    search.data.items.forEach((asset: any) => {
      core.info(`  - "${asset.name}" (ID: ${asset.id})`)
    })

    for (const asset of search.data.items) {
      if (asset.name === name) {
        core.info(`✅ Found exact match: "${asset.name}" (ID: ${asset.id})`)
        return asset.id.toString()
      }
    }

    const suggestions = search.data.items
      .map((asset: any) => `"${asset.name}"`)
      .join(', ')
    core.error(`❌ No exact match found for "${name}"`)
    core.error(`💡 Available assets: ${suggestions}`)

    throw new Error(
      `No exact match found for "${name}". Available assets: ${suggestions}`
    )
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 401) {
        throw new Error(
          'Authentication failed. Check if your forum cookie is valid.'
        )
      } else if (error.response?.status === 403) {
        throw new Error(
          'Access denied. Make sure you have permission to view assets.'
        )
      }
      core.error(
        `API Error: ${error.response?.status} ${error.response?.statusText}`
      )
    }
    throw error
  }
}

export function getUrl(type: keyof typeof Urls, id?: string): string {
  const url = Urls.API + Urls[type]
  return id ? url.replace('{id}', id) : url
}

type TreeNode = string | Record<string, TreeNode[]> | null

function buildTree(currentPath: string): TreeNode {
  const stats = fs.statSync(currentPath)

  if (stats.isFile()) {
    return path.basename(currentPath)
  }

  if (stats.isDirectory()) {
    const children = fs.readdirSync(currentPath)
    return {
      [path.basename(currentPath)]: children.map((child: string) =>
        buildTree(path.join(currentPath, child))
      )
    }
  }

  return null
}

export function getEnv(name: string): string {
  if (process.env[name] === undefined) {
    throw new Error(`Environment variable ${name} is not set.`)
  }

  return process.env[name]
}

export async function zipAsset(assetName: string): Promise<string> {
  core.debug('Zipping asset...')

  const workspacePath = getEnv('GITHUB_WORKSPACE')
  const outputZipPath = assetName + '.zip'
  const zipfile = new yazl.ZipFile()

  function addDirectoryToZip(dir: string, zipPath: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const entryZipPath = path.join(zipPath, entry.name)
      if (entry.isDirectory()) {
        core.debug(`Entering directory ${fullPath}...`)
        addDirectoryToZip(fullPath, entryZipPath)
      } else if (entry.isFile()) {
        core.debug(`Adding file ${fullPath} as ${entryZipPath}...`)
        zipfile.addFile(fullPath, entryZipPath, { compress: true })
      }
    }
  }

  core.debug('Adding files to zip...')
  addDirectoryToZip(workspacePath, assetName)

  core.debug(
    'Zip content: ' + JSON.stringify(buildTree(workspacePath), null, 2)
  )
  zipfile.end()

  const outputStream = fs.createWriteStream(outputZipPath)
  return new Promise((resolve, reject) => {
    zipfile.outputStream
      .pipe(outputStream)
      .on('close', () => {
        console.log(`Asset zipped to ${outputZipPath}`)
        resolve(path.resolve(outputZipPath))
      })
      .on('error', reject)
  })
}

export function deleteIfExists(_path: string): void {
  _path = path.join(getEnv('GITHUB_WORKSPACE'), _path)

  try {
    if (fs.existsSync(_path)) {
      core.debug(`Deleting ${_path}...`)
      const stats = fs.lstatSync(_path)

      if (stats.isDirectory()) {
        fs.rmSync(_path, { recursive: true, force: true })
      } else if (stats.isFile()) {
        fs.unlinkSync(_path)
      }
    } else {
      core.debug(`${_path} does not exist, skipping`)
    }
  } catch (error) {
    core.debug(`Skipping ${_path} deletion due to error: ${error as string}`)
  }
}

/**
 * Builds web and DUI if they exist
 * @param resourcePath Optional subdirectory within workspace
 */
async function buildWebAndDui(resourcePath?: string): Promise<void> {
  const workspacePath = getEnv('GITHUB_WORKSPACE')
  const basePath = resourcePath
    ? path.join(workspacePath, resourcePath)
    : workspacePath

  const webPath = path.join(basePath, 'web')
  if (fs.existsSync(webPath)) {
    core.info('🔨 Building web files...')
    const { spawn } = require('child_process')

    await new Promise<void>((resolve, reject) => {
      const buildProcess = spawn('pnpm', ['install'], {
        cwd: webPath,
        stdio: 'inherit',
        shell: true
      })

      buildProcess.on('close', (code: number | null) => {
        if (code === 0) {
          const buildCmd = spawn('pnpm', ['build'], {
            cwd: webPath,
            stdio: 'inherit',
            shell: true
          })

          buildCmd.on('close', (buildCode: number | null) => {
            if (buildCode === 0) {
              core.info('✅ Web build completed')
              resolve()
            } else {
              reject(new Error(`Web build failed with code ${buildCode}`))
            }
          })
        } else {
          reject(new Error(`Web install failed with code ${code}`))
        }
      })
    })
  }

  const duiPath = path.join(basePath, 'dui')
  if (fs.existsSync(duiPath)) {
    core.info('🔨 Building DUI files...')
    const { spawn } = require('child_process')

    await new Promise<void>((resolve, reject) => {
      const installProcess = spawn('pnpm', ['install'], {
        cwd: duiPath,
        stdio: 'inherit',
        shell: true
      })

      installProcess.on('close', (code: number | null) => {
        if (code === 0) {
          const buildCmd = spawn('pnpm', ['build'], {
            cwd: duiPath,
            stdio: 'inherit',
            shell: true
          })

          buildCmd.on('close', (buildCode: number | null) => {
            if (buildCode === 0) {
              // Copy DUI build files
              const duiBuildPath = path.join(duiPath, 'build')
              const targetDuiBuildPath = path.join(basePath, 'dui', 'build')

              if (fs.existsSync(duiBuildPath)) {
                if (!fs.existsSync(targetDuiBuildPath)) {
                  fs.mkdirSync(targetDuiBuildPath, { recursive: true })
                }
                copyRecursivelyFiltered(
                  duiBuildPath,
                  targetDuiBuildPath,
                  [],
                  false
                )
              }

              core.info('✅ DUI build completed')
              resolve()
            } else {
              reject(new Error(`DUI build failed with code ${buildCode}`))
            }
          })
        } else {
          reject(new Error(`DUI install failed with code ${code}`))
        }
      })
    })
  }
}

/**
 * Creates escrowed version of the asset
 * Uses the unified createResourceVersion function
 */
export async function createEscrowedVersion(
  _assetName: string,
  resourcePath?: string
): Promise<string> {
  return createResourceVersion({
    type: 'escrowed',
    assetName: _assetName,
    resourcePath
  })
}

/**
 * Creates open source version of the asset
 * Uses the unified createResourceVersion function
 */
export async function createOpenSourceVersion(
  _assetName: string,
  resourcePath?: string
): Promise<string> {
  return createResourceVersion({
    type: 'opensource',
    assetName: _assetName,
    resourcePath
  })
}

/**
 * Creates a zip file from a directory
 * @param sourceDir Source directory to zip
 * @param zipPath Output zip file path
 * @param _rootFolderName Name of the root folder in the zip (unused, kept for API compatibility)
 * @param excludePaths Paths to exclude from the zip
 * @returns Promise resolving to the absolute path of the created zip file
 */
async function zipDirectory(
  sourceDir: string,
  zipPath: string,
  _rootFolderName: string,
  excludePaths: string[] = []
): Promise<string> {
  const zipfile = new yazl.ZipFile()
  const outputZipPath = path.resolve(zipPath)

  // Normalize exclude paths for comparison
  const normalizedExcludes = excludePaths.map(p => path.normalize(p))

  function addDirectoryToZip(dir: string, zipPath: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(sourceDir, fullPath)

      // Check if this path should be excluded
      const shouldExclude = normalizedExcludes.some(exclude => {
        const normalized = path.normalize(relativePath)
        return (
          normalized === exclude || normalized.startsWith(exclude + path.sep)
        )
      })

      if (shouldExclude) {
        core.debug(`Excluding from ZIP: ${relativePath}`)
        continue
      }

      const entryZipPath = path.join(zipPath, entry.name)
      if (entry.isDirectory()) {
        addDirectoryToZip(fullPath, entryZipPath)
      } else if (entry.isFile()) {
        zipfile.addFile(fullPath, entryZipPath, { compress: true })
      }
    }
  }

  // Add files inside root folder with the resource name
  addDirectoryToZip(sourceDir, _rootFolderName)
  zipfile.end()

  const outputStream = fs.createWriteStream(outputZipPath)
  return new Promise((resolve, reject) => {
    zipfile.outputStream
      .pipe(outputStream)
      .on('close', () => {
        core.info(`Directory zipped to ${outputZipPath}`)
        resolve(outputZipPath)
      })
      .on('error', reject)
  })
}

/**
 * Creates both escrowed and open source versions based on options
 * @param options Build options
 * @param assetName Base asset name
 * @returns Object containing paths to created zip files
 */
export async function createVersions(
  options: BuildOptions,
  assetName: string
): Promise<ZipPaths> {
  const zipPaths: ZipPaths = {}

  deleteIfExists('escrowed/')
  deleteIfExists('open-source/')

  if (options.createEscrowed) {
    const escrowedName =
      options.escrowedConfig?.asset_name || `${assetName}-escrowed`
    zipPaths.escrowed = await createEscrowedVersion(
      escrowedName,
      options.resourcePath
    )
  }

  if (options.createOpenSource) {
    const openSourceName =
      options.openSourceConfig?.asset_name || `${assetName}-source`
    zipPaths.openSource = await createOpenSourceVersion(
      openSourceName,
      options.resourcePath
    )
  }

  return zipPaths
}
