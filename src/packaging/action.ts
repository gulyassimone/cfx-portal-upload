import * as core from '@actions/core'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { readReleaseVersion, setRunVersion } from '../release-version'
import { inspectResourceZip, InspectedZip, verifyWebFiles } from './inspect'
import { createRuntimePackage } from './runtime'
import {
  listFiles,
  sourceFile,
  validateResourceName,
  validateRelativePath
} from './paths'

function writeProvenance(
  directory: string,
  resource: string,
  result: InspectedZip,
  runtime: boolean
): void {
  const sha = process.env.GITHUB_SHA || ''
  if (!/^[a-f0-9]{40}$/i.test(sha))
    throw new Error('Expected full Git commit SHA in GITHUB_SHA')
  const filename = `${resource}-release.zip`
  fs.writeFileSync(
    path.join(directory, 'contents.txt'),
    `${result.files.join('\n')}\n`
  )
  fs.writeFileSync(
    path.join(directory, 'SHA256SUMS'),
    `${result.sha256}  ${filename}\n`
  )
  fs.writeFileSync(
    path.join(directory, `${resource}-release.metadata.json`),
    JSON.stringify(
      {
        resource,
        commit: sha,
        version: result.version,
        zip: filename,
        ...(runtime ? { tar: `${resource}.tar.gz` } : {}),
        sha256: result.sha256,
        files: result.files,
        fileHashes: result.hashes,
        encrypted: false
      },
      null,
      2
    ) + '\n'
  )
}

export async function runPackage(): Promise<void> {
  const resourceName = core.getInput('resource-name', { required: true })
  validateResourceName(resourceName)
  const operation = core.getInput('operation', { required: true })
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
  const webPath = core.getInput('web-build-path')
  if (webPath) validateRelativePath(webPath)
  if (operation === 'prepare') {
    const manifestPath = sourceFile(
      workspace,
      core.getInput('manifest-path') || 'fxmanifest.lua'
    )
    const manifest = fs.readFileSync(manifestPath, 'utf8')
    const mode = core.getInput('version-mode') || 'run'
    if (mode !== 'run' && mode !== 'manifest')
      throw new Error('version-mode must be run or manifest')
    const release =
      mode === 'run'
        ? setRunVersion(
            manifest,
            process.env.GITHUB_RUN_NUMBER || '',
            process.env.GITHUB_RUN_ATTEMPT || ''
          )
        : { manifest, version: readReleaseVersion(manifest) }
    if (webPath) {
      const root = path.dirname(manifestPath)
      sourceFile(root, `${webPath}/index.html`)
      verifyWebFiles(
        listFiles(path.join(root, webPath)).map(
          file => `${resourceName}/${webPath}/${file}`
        ),
        resourceName,
        webPath
      )
    }
    fs.writeFileSync(manifestPath, release.manifest)
    core.setOutput('version', release.version)
    core.info(
      `Preparing ${resourceName} ${release.version}; no web build is run`
    )
    return
  }
  if (!['package', 'collect', 'inspect'].includes(operation))
    throw new Error('operation must be prepare, package, collect or inspect')
  let directory: string | undefined
  try {
    let zipPath: string
    let result: InspectedZip
    if (operation === 'package') {
      const manifestPath = sourceFile(
        workspace,
        core.getInput('manifest-path') || 'fxmanifest.lua'
      )
      if (path.basename(manifestPath) !== 'fxmanifest.lua')
        throw new Error('Runtime packaging requires an fxmanifest.lua')
      const built = await createRuntimePackage(
        path.dirname(manifestPath),
        resourceName,
        webPath
      )
      directory = built.directory
      zipPath = built.zipPath
      result = built.result
    } else {
      zipPath = sourceFile(
        workspace,
        core.getInput('zip-path', { required: true })
      )
      result = await inspectResourceZip(zipPath, resourceName)
    }
    const expected = core.getInput('expected-version', { required: true })
    if (result.version !== expected)
      throw new Error(
        `Packaged version ${result.version} does not match expected ${expected}`
      )
    verifyWebFiles(result.files, resourceName, webPath)
    if (operation === 'inspect') {
      if (
        result.sha256 !== core.getInput('expected-sha256', { required: true })
      )
        throw new Error('ZIP SHA-256 does not match the package job output')
    } else {
      if (!directory) {
        directory = fs.mkdtempSync(
          path.join(
            process.env.RUNNER_TEMP || os.tmpdir(),
            `cfx-release-${resourceName}-`
          )
        )
        fs.copyFileSync(
          zipPath,
          path.join(directory, `${resourceName}-release.zip`)
        )
      }
      writeProvenance(directory, resourceName, result, operation === 'package')
      core.setOutput('artifact-directory', directory)
    }
    core.setOutput('version', result.version)
    core.setOutput('sha256', result.sha256)
    core.info(
      `Verified ${resourceName} ${result.version}: ${result.files.length} files, SHA-256 ${result.sha256}`
    )
  } catch (error) {
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
