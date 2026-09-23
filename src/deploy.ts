import * as core from '@actions/core'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { Client } from 'ssh2'
import {
  SSHConfig,
  DeployConfig,
  PortalAsset,
  PortalAssetsResponse,
  UploadedVersion
} from './types'

const PORTAL_API = 'https://portal-api.cfx.re/v1'

/**
 * Find asset by name from CFX Portal
 */
async function findAssetByName(
  cookie: string,
  assetName: string
): Promise<PortalAsset> {
  core.info(`Searching for asset: "${assetName}"...`)

  let page = 1
  const maxPages = 10

  while (page <= maxPages) {
    const url = `${PORTAL_API}/me/assets?page=${page}&search=${encodeURIComponent(assetName)}&sort=asset.id&direction=desc`

    const response = await axios.get<PortalAssetsResponse>(url, {
      headers: { Cookie: cookie }
    })

    const asset = response.data.items.find(a => a.name === assetName)
    if (asset) {
      core.info(`Found asset: "${asset.name}" (ID: ${asset.id})`)
      return asset
    }

    if (page >= response.data.page_count) break
    page++
  }

  throw new Error(`Asset "${assetName}" not found on CFX Portal`)
}

/** Wait only for the version created by this upload, including its pack. */
export async function waitForUploadedVersion(
  cookie: string,
  assetName: string,
  uploaded: UploadedVersion,
  maxAttempts = 60,
  delayMs = 5000
): Promise<{ asset: PortalAsset; version: PortalAsset['versions'][number] }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const asset = await findAssetByName(cookie, assetName)
    if (asset.id !== uploaded.assetId) {
      throw new Error(
        'Portal asset does not match the uploaded asset; deployment is blocked.'
      )
    }
    const version = asset.versions?.find(v => v.id === uploaded.versionId)
    if (version?.state === 'active' && version.packs?.length > 0) {
      core.info(`Uploaded version is ready: ${uploaded.versionId}`)
      return { asset, version }
    }
    core.info(
      `Waiting for uploaded version ${uploaded.versionId}: ${version?.state || 'not visible'} (${attempt}/${maxAttempts})`
    )
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw new Error(
    `Uploaded version ${uploaded.versionId} is not ready; deployment is blocked. No older version will be used.`
  )
}

/**
 * Download asset from CFX Portal
 */
export async function downloadAsset(
  cookie: string,
  assetName: string,
  uploaded: UploadedVersion
): Promise<string> {
  core.info(`Downloading asset "${assetName}" from CFX Portal...`)

  const { asset, version } = await waitForUploadedVersion(
    cookie,
    assetName,
    uploaded
  )

  const pack = version.packs[0]

  core.info(
    `Asset ID: ${asset.id}, Version ID: ${version.id}, Pack ID: ${pack.id}`
  )

  // Download - first get the signed URL from API
  const downloadUrl = `${PORTAL_API}/assets/${asset.id}/versions/${version.id}/packs/${pack.id}/download`
  core.info(`Requesting download URL from: ${downloadUrl}`)

  // Get the signed URL from the API
  const urlResponse = await axios.get<{ url: string }>(downloadUrl, {
    headers: { Cookie: cookie }
  })

  if (!urlResponse.data?.url) {
    core.error(`Unexpected API response: ${JSON.stringify(urlResponse.data)}`)
    throw new Error('API did not return a download URL')
  }

  const signedUrl = urlResponse.data.url
  core.info(`Got signed download URL`)

  // Download the actual file from the signed URL
  const response = await axios.get(signedUrl, {
    responseType: 'arraybuffer',
    maxRedirects: 5
  })

  // Validate response
  const contentType = response.headers['content-type'] || ''
  core.info(`Response content-type: ${contentType}`)

  if (response.data.length < 100) {
    const textContent = Buffer.from(response.data)
      .toString('utf8')
      .substring(0, 500)
    core.error(
      `Response too small (${response.data.length} bytes): ${textContent}`
    )
    throw new Error('Downloaded file is too small, likely an error response')
  }

  // Check ZIP magic bytes (PK)
  const header = Buffer.from(response.data).subarray(0, 2)
  if (header[0] !== 0x50 || header[1] !== 0x4b) {
    const textContent = Buffer.from(response.data)
      .toString('utf8')
      .substring(0, 500)
    core.error(`Invalid ZIP file header. Content preview: ${textContent}`)
    throw new Error('Downloaded file is not a valid ZIP archive')
  }

  // Use safe filename without spaces
  const safeFileName = assetName.toLowerCase().replace(/\s+/g, '_')
  const zipPath = path.join(process.cwd(), `${safeFileName}.zip`)
  fs.writeFileSync(zipPath, response.data)

  const fileSizeKB = Math.round(response.data.length / 1024)
  core.info(`Downloaded: ${zipPath} (${fileSizeKB} KB)`)

  return zipPath
}

/**
 * Deploy asset to server via SSH
 */
export async function deployToServer(
  sshConfig: SSHConfig,
  deployPath: string,
  zipPath: string,
  resourceName: string,
  backupPath: string
): Promise<void> {
  core.info(`Deploying to ${sshConfig.host}...`)

  return new Promise((resolve, reject) => {
    const conn = new Client()

    conn.on('ready', () => {
      core.info('SSH connection established')

      conn.sftp((err, sftp) => {
        if (err) {
          conn.end()
          reject(err)
          return
        }

        const zipFileName = path.basename(zipPath)
        const remoteTempPath = `/tmp/${zipFileName}`

        core.info(`Uploading to ${remoteTempPath}...`)

        const fileData = fs.readFileSync(zipPath)

        sftp.writeFile(remoteTempPath, fileData, uploadErr => {
          if (uploadErr) {
            conn.end()
            reject(uploadErr)
            return
          }

          core.info('Upload complete')

          // Expand ~ to $HOME in the shell, and construct the path there
          // This ensures tilde expansion works correctly
          const backupId = `${new Date()
            .toISOString()
            .replace(/[-:.]/g, '')}-${sanitizeIdentifier(
            process.env.GITHUB_REF_NAME || process.env.GITHUB_SHA || 'unknown'
          )}`
          const resourcePath = `${deployPath}/${resourceName}`
          const snapshotPath = `${backupPath}/${resourceName}/${backupId}`

          core.info(`Extracting to ${deployPath}...`)
          core.info(`Creating backup ${backupId} before extraction...`)

          const commands = [
            `mkdir -p ${remotePathQuote(snapshotPath)}`,
            `if [ -d ${remotePathQuote(resourcePath)} ]; then cp -a ${remotePathQuote(resourcePath)}/. ${remotePathQuote(snapshotPath)}/; fi`,
            `mkdir -p ${remotePathQuote(deployPath)}`,
            `unzip -o ${shellQuote(remoteTempPath)} -d ${remotePathQuote(deployPath)}`,
            `rm -f ${shellQuote(remoteTempPath)}`
          ]

          const fullCommand = commands.join(' && ')

          conn.exec(fullCommand, (execErr, stream) => {
            if (execErr) {
              conn.end()
              reject(execErr)
              return
            }

            let output = ''
            let errorOutput = ''

            stream.on('data', (data: Buffer) => {
              output += data.toString()
            })

            stream.stderr.on('data', (data: Buffer) => {
              errorOutput += data.toString()
            })

            stream.on('close', (code: number) => {
              conn.end()

              if (code !== 0) {
                core.warning(`Command output: ${output}`)
                core.error(`Command error: ${errorOutput}`)
                reject(new Error(`SSH command failed with code ${code}`))
                return
              }

              core.info(
                `Resource installed to ${deployPath}/${resourceName}; restart is required before operation can be verified`
              )
              core.info(`Backup saved as ${backupId}`)
              resolve()
            })
          })
        })
      })
    })

    conn.on('error', err => {
      reject(new Error(`SSH connection error: ${err.message}`))
    })

    core.info(`Connecting to ${sshConfig.host}:${sshConfig.port}...`)

    conn.connect({
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      privateKey: sshConfig.privateKey
    })
  })
}

/** Restore a snapshot without restarting the server. */
export async function rollbackToServer(
  sshConfig: SSHConfig,
  deployPath: string,
  resourceName: string,
  backupPath: string,
  backupId: string
): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(backupId)) {
    throw new Error('Invalid rollback backup identifier')
  }

  return runRemoteCommand(
    sshConfig,
    [
      `resource_path=${remotePathQuote(`${deployPath}/${resourceName}`)}`,
      `snapshot_path=${remotePathQuote(`${backupPath}/${resourceName}/${backupId}`)}`,
      'test -d "$snapshot_path"',
      'rm -rf "$resource_path"',
      'mkdir -p "$resource_path"',
      'cp -a "$snapshot_path"/. "$resource_path"/'
    ],
    `Resource rolled back from ${backupId}; restart is required before operation can be verified`
  )
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function remotePathQuote(value: string): string {
  if (value === '~') return '"$HOME"'
  if (value.startsWith('~/')) {
    return `"$HOME"${shellQuote(value.slice(1))}`
  }
  return shellQuote(value)
}

async function runRemoteCommand(
  sshConfig: SSHConfig,
  commands: string[],
  successMessage: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = new Client()

    conn.on('ready', () => {
      conn.exec(commands.join(' && '), (execErr, stream) => {
        if (execErr) {
          conn.end()
          reject(execErr)
          return
        }

        let output = ''
        let errorOutput = ''
        stream.on('data', (data: Buffer) => {
          output += data.toString()
        })
        stream.stderr.on('data', (data: Buffer) => {
          errorOutput += data.toString()
        })
        stream.on('close', (code: number) => {
          conn.end()
          if (code !== 0) {
            core.warning(`Command output: ${output}`)
            core.error(`Command error: ${errorOutput}`)
            reject(new Error(`SSH command failed with code ${code}`))
            return
          }
          core.info(successMessage)
          resolve()
        })
      })
    })
    conn.on('error', err =>
      reject(new Error(`SSH connection error: ${err.message}`))
    )
    conn.connect({
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      privateKey: sshConfig.privateKey
    })
  })
}

/**
 * Main deploy function - downloads from portal and deploys via SSH
 */
export async function deployAsset(
  cookie: string,
  assetName: string,
  deployConfig: DeployConfig,
  uploaded: UploadedVersion
): Promise<void> {
  if (!deployConfig.enabled || !deployConfig.sshConfig) {
    return
  }

  core.info('')
  core.info('='.repeat(50))
  core.info('Starting deployment...')
  core.info('='.repeat(50))

  // Download asset from portal (ZIP contains resource folder inside)
  const zipPath = await downloadAsset(cookie, assetName, uploaded)

  // Deploy to server - just extract to deploy_path, folder is already in ZIP
  await deployToServer(
    deployConfig.sshConfig,
    deployConfig.deployPath,
    zipPath,
    deployConfig.resourceName || assetName,
    deployConfig.backupPath
  )

  // Cleanup
  try {
    fs.unlinkSync(zipPath)
  } catch {
    // Ignore cleanup errors
  }

  core.info('')
  core.info('Deployment completed successfully!')
}
