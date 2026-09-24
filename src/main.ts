import { getDeployPaths } from './deploy-config'
import { logPortalRequest } from './portal-log'
import * as core from '@actions/core'
import puppeteer, { Browser, Page } from 'puppeteer'
import FormData from 'form-data'
import axios from 'axios'

import { createReadStream, statSync } from 'fs'
import { basename } from 'path'
import {
  ReUploadResponse,
  CreateAssetResponse,
  Urls,
  SSOResponseBody,
  BuildOptions,
  DeployConfig,
  UploadedVersion
} from './types'
import { deployAsset, rollbackToServer } from './deploy'
import { parseUploadedVersion } from './upload-version'
import { sendDiscordNotification } from './discord'
import {
  deleteIfExists,
  resolveAssetId,
  findAssetId,
  getEnv,
  getUrl,
  preparePuppeteer,
  zipAsset,
  createVersions
} from './utils'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  const rollbackMode = core.getInput('rollback').toLowerCase() === 'true'

  if (rollbackMode) {
    try {
      const sshHost = core.getInput('ssh_host')
      const sshUser = core.getInput('ssh_user')
      const sshKey = core.getInput('ssh_key')
      const sshPort = parseInt(core.getInput('ssh_port') || '22')
      const { deployPath, backupPath } = getDeployPaths()
      const resourceName = core.getInput('deploy_resource_name')
      const backupId = core.getInput('rollback_backup')

      if (!sshHost || !sshUser || !sshKey || !resourceName || !backupId) {
        throw new Error(
          'Rollback requires ssh_host, ssh_user, ssh_key, deploy_resource_name and rollback_backup'
        )
      }

      await rollbackToServer(
        { host: sshHost, port: sshPort, username: sshUser, privateKey: sshKey },
        deployPath,
        resourceName,
        backupPath,
        backupId
      )
      return
    } catch (error) {
      core.setFailed(error instanceof Error ? error.message : String(error))
      return
    }
  }

  let browser: Browser | undefined
  try {
    const executablePath = await preparePuppeteer()
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    })
    const page = await browser.newPage()

    let assetId = core.getInput('assetId')
    let assetName = core.getInput('assetName')

    let zipPath = core.getInput('zipPath')
    const makeZip = core.getInput('makeZip').toLowerCase() === 'true'
    const packageMode = core.getInput('packageMode') || 'all'
    const skipUpload = core.getInput('skipUpload').toLowerCase() === 'true'
    const createIfMissing =
      core.getInput('createIfMissing').toLowerCase() !== 'false'
    const assetVersion = core.getInput('assetVersion') || '1.0.0'

    // Version config inputs
    const escrowedInput = core.getInput('escrowed')
    const openSourceInput = core.getInput('openSource')
    const resourcePath = core.getInput('resourcePath')

    const chunkSize = parseInt(core.getInput('chunkSize'))
    const maxRetries = parseInt(core.getInput('maxRetries'))

    // Deploy config
    const deployEnabled = core.getInput('deploy').toLowerCase() === 'true'
    const sshHost = core.getInput('ssh_host')
    const sshUser = core.getInput('ssh_user')
    const sshKey = core.getInput('ssh_key')
    const sshPort = parseInt(core.getInput('ssh_port') || '22')
    const { deployPath, backupPath } = getDeployPaths()
    const deployResourceName = core.getInput('deploy_resource_name')
    const discordWebhook = core.getInput('discord_webhook')

    const deployConfig: DeployConfig = {
      enabled: deployEnabled && !!sshHost && !!sshUser && !!sshKey,
      deployPath,
      resourceName: deployResourceName || undefined,
      backupPath
    }

    if (deployConfig.enabled) {
      deployConfig.sshConfig = {
        host: sshHost,
        port: sshPort,
        username: sshUser,
        privateKey: sshKey
      }
      core.info('Deploy enabled - will deploy after upload')
    }

    if (isNaN(chunkSize)) {
      throw new Error('Invalid chunk size. Must be a number.')
    }

    if (isNaN(maxRetries)) {
      throw new Error('Invalid max retries. Must be a number.')
    }

    // No asset id or name provided, using the repository name
    // If skipUpload is true, we don't need to update the asset name
    if (!assetId && !assetName && !skipUpload) {
      core.debug('No asset id or name provided, using repository name...')
      assetName = basename(getEnv('GITHUB_WORKSPACE'))
    }

    const redirectUrl = await getRedirectUrl(page, maxRetries)
    await setForumCookie(browser, page)

    core.info('Navigating to CFX Portal...')
    core.info(`Redirect URL: ${redirectUrl}`)

    await page.goto(redirectUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    })

    await new Promise(resolve => setTimeout(resolve, 3000))

    const currentUrl = page.url()
    core.info(`Current URL after navigation: ${currentUrl}`)

    if (currentUrl.includes('portal.cfx.re')) {
      if (skipUpload) {
        core.info('Redirected to CFX Portal. Skipping upload ...')
        return
      }

      core.info('Redirected to CFX Portal. Processing uploads ...')
      const cookies = await getCookies(browser)

      // Parse structured inputs
      let escrowedConfig: any = null
      let openSourceConfig: any = null

      core.info(`📝 Raw escrowedInput: ${JSON.stringify(escrowedInput)}`)
      core.info(`📝 Raw openSourceInput: ${JSON.stringify(openSourceInput)}`)

      if (escrowedInput) {
        core.info('🔧 Parsing escrowed config...')
        try {
          escrowedConfig = JSON.parse(escrowedInput)
          core.info('✅ Parsed escrowed as JSON')
        } catch {
          // Try YAML-like parsing for simple cases
          core.info('⚠️ JSON parse failed, trying YAML-like parsing...')
          const lines = escrowedInput.split('\n').filter(line => line.trim())
          escrowedConfig = {}
          for (const line of lines) {
            const match = line.match(/^\s*(\w+):\s*(.+)$/)
            if (match) {
              const [, key, value] = match
              core.info(`  Found key: ${key}, value: ${value}`)
              // Only parse asset_id, asset_name, branch
              if (['asset_id', 'asset_name', 'branch'].includes(key)) {
                escrowedConfig[key] = value.replace(/[\"']/g, '').trim()
              }
            }
          }
          core.info(
            `✅ Parsed escrowed config: ${JSON.stringify(escrowedConfig)}`
          )
        }
      }

      if (openSourceInput) {
        core.info('🔧 Parsing openSource config...')
        try {
          openSourceConfig = JSON.parse(openSourceInput)
          core.info('✅ Parsed openSource as JSON')
        } catch {
          core.info('⚠️ JSON parse failed, trying YAML-like parsing...')
          const lines = openSourceInput.split('\n').filter(line => line.trim())
          openSourceConfig = {}
          for (const line of lines) {
            const match = line.match(/^\s*(\w+):\s*(.+)$/)
            if (match) {
              const [, key, value] = match
              core.info(`  Found key: ${key}, value: ${value}`)
              // Only parse asset_id, asset_name, branch
              if (['asset_id', 'asset_name', 'branch'].includes(key)) {
                openSourceConfig[key] = value.replace(/[\"']/g, '').trim()
              }
            }
          }
          core.info(
            `✅ Parsed openSource config: ${JSON.stringify(openSourceConfig)}`
          )
        }
      }

      // Determine which versions to create
      const shouldCreateEscrowed = !!escrowedConfig
      const shouldCreateOpenSource = !!openSourceConfig

      const uploadTypes = []
      if (shouldCreateEscrowed) uploadTypes.push('escrowed')
      if (shouldCreateOpenSource) uploadTypes.push('open-source')
      core.info(`🚀 Creating versions: ${uploadTypes.join(', ')}`)

      let uploadedForDeployment: UploadedVersion | undefined

      // Check if we should create multiple versions
      if (shouldCreateEscrowed || shouldCreateOpenSource) {
        core.info('🚀 Using multi-version upload logic')
        const buildOptions: BuildOptions = {
          createEscrowed: shouldCreateEscrowed,
          createOpenSource: shouldCreateOpenSource,
          escrowedConfig: escrowedConfig || undefined,
          openSourceConfig: openSourceConfig || undefined,
          resourcePath: resourcePath || undefined
        }

        const baseAssetName = assetName || basename(getEnv('GITHUB_WORKSPACE'))
        const zipPaths = await createVersions(buildOptions, baseAssetName)

        // Upload escrowed version
        if (zipPaths.escrowed && shouldCreateEscrowed) {
          let escrowedId: string

          if (escrowedConfig?.asset_id) {
            escrowedId = escrowedConfig.asset_id
            core.info(`Using escrowed asset_id: ${escrowedId}`)
          } else if (escrowedConfig?.asset_name) {
            core.info(
              `Looking up escrowed asset by name: ${escrowedConfig.asset_name}`
            )
            if (createIfMissing) {
              const existing = await findAssetId(
                escrowedConfig.asset_name,
                cookies
              )
              if (!existing) {
                uploadedForDeployment = await createAsset(
                  zipPaths.escrowed,
                  escrowedConfig.asset_name,
                  assetVersion,
                  chunkSize,
                  cookies
                )
                escrowedId = ''
              } else escrowedId = existing
            } else
              escrowedId = await resolveAssetId(
                escrowedConfig.asset_name,
                cookies
              )
          } else {
            throw new Error(
              'Escrowed config must include asset_id or asset_name'
            )
          }

          core.info('Uploading escrowed version ...')
          if (escrowedId)
            uploadedForDeployment = await uploadZip(
              zipPaths.escrowed,
              escrowedId,
              chunkSize,
              cookies,
              assetVersion
            )
        }

        // Upload open source version
        if (zipPaths.openSource && shouldCreateOpenSource) {
          let openSourceId: string

          if (openSourceConfig?.asset_id) {
            openSourceId = openSourceConfig.asset_id
            core.info(`Using openSource asset_id: ${openSourceId}`)
          } else if (openSourceConfig?.asset_name) {
            core.info(
              `Looking up openSource asset by name: ${openSourceConfig.asset_name}`
            )
            if (createIfMissing) {
              const existing = await findAssetId(
                openSourceConfig.asset_name,
                cookies
              )
              if (!existing) {
                const created = await createAsset(
                  zipPaths.openSource,
                  openSourceConfig.asset_name,
                  assetVersion,
                  chunkSize,
                  cookies
                )
                uploadedForDeployment ??= created
                openSourceId = ''
              } else openSourceId = existing
            } else
              openSourceId = await resolveAssetId(
                openSourceConfig.asset_name,
                cookies
              )
          } else {
            throw new Error(
              'OpenSource config must include asset_id or asset_name'
            )
          }

          core.info('Uploading open source version ...')
          if (openSourceId) {
            const uploadedOpenSource = await uploadZip(
              zipPaths.openSource,
              openSourceId,
              chunkSize,
              cookies,
              assetVersion
            )
            uploadedForDeployment ??= uploadedOpenSource
          }
        }
      } else {
        core.info('⚠️ Using single upload logic (fallback)')
        core.info(`  assetName: ${assetName}`)
        core.info(`  assetId: ${assetId}`)

        // Original single upload logic
        if (assetName && createIfMissing && !assetId) {
          const existing = await findAssetId(assetName, cookies)
          zipPath = await getZipPath(assetName, zipPath, makeZip, packageMode)
          core.info(
            existing
              ? `Using existing asset "${assetName}" (ID: ${existing})`
              : `Asset "${assetName}" was not found; creating it`
          )
          uploadedForDeployment = existing
            ? await uploadZip(
                zipPath,
                existing,
                chunkSize,
                cookies,
                assetVersion
              )
            : await createAsset(
                zipPath,
                assetName,
                assetVersion,
                chunkSize,
                cookies
              )
        } else {
          if (assetName) {
            core.info(`🔍 Looking up single asset by name: ${assetName}`)
            assetId = await resolveAssetId(assetName, cookies)
          }

          zipPath = await getZipPath(assetName, zipPath, makeZip, packageMode)
          uploadedForDeployment = await uploadZip(
            zipPath,
            assetId,
            chunkSize,
            cookies,
            assetVersion
          )
        }
      }

      // Deploy after successful upload
      const assetToDeployName =
        escrowedConfig?.asset_name || openSourceConfig?.asset_name || assetName

      let deployed = false
      if (deployConfig.enabled) {
        if (assetToDeployName) {
          if (!uploadedForDeployment)
            throw new Error(
              'Missing uploaded version identity; deployment is blocked.'
            )
          await deployAsset(
            cookies,
            assetToDeployName,
            deployConfig,
            uploadedForDeployment
          )
          deployed = true
        } else {
          core.warning('Deploy enabled but no asset name found to deploy')
        }
      }

      // Send Discord notification on success
      if (discordWebhook) {
        await sendDiscordNotification({
          webhookUrl: discordWebhook,
          assetName: assetToDeployName || 'Unknown',
          success: true,
          deployed,
          deployHost: deployConfig.sshConfig?.host,
          resourceName: deployConfig.resourceName || assetToDeployName
        })
      }
    } else {
      core.error(`❌ Failed to reach CFX Portal`)
      core.error(`Current URL: ${currentUrl}`)
      core.error(`Expected URL to contain: portal.cfx.re`)
      core.error(`Redirect URL was: ${redirectUrl}`)
      throw new Error(
        `Redirect failed. Current URL: ${currentUrl}. Make sure the provided Cookie is valid and not expired.`
      )
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    core.setFailed(errorMessage)

    // Send Discord notification on failure
    const discordWebhook = core.getInput('discord_webhook')
    if (discordWebhook) {
      const assetName =
        core.getInput('assetName') || core.getInput('assetId') || 'Unknown'
      await sendDiscordNotification({
        webhookUrl: discordWebhook,
        assetName,
        success: false,
        error: errorMessage
      })
    }
  } finally {
    await browser?.close()
  }
}

/**
 * Navigates to the SSO URL and waits for the page to load.
 * If the navigation fails, it will retry up to `maxRetries` times.
 * @param page
 * @param maxRetries
 * @returns {Promise<string>} The redirect URL.
 * @throws If the navigation fails after `maxRetries` attempts.
 */
async function getRedirectUrl(page: Page, maxRetries: number): Promise<string> {
  let loaded = false
  let attempt = 0
  let redirectUrl = null

  while (!loaded && attempt < maxRetries) {
    try {
      core.info('Navigating to SSO URL ...')

      await page.goto(getUrl('SSO'), {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      })

      core.info('Navigated to SSO URL. Parsing response body ...')

      const responseBody = await page.evaluate(
        () => JSON.parse(document.body.innerText) as SSOResponseBody
      )

      core.debug('Parsed response body.')

      redirectUrl = responseBody.url

      core.info('Redirected to Forum Origin ...')

      const forumUrl = new URL(redirectUrl).origin
      await page.goto(forumUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      })

      loaded = true
    } catch {
      core.info(`Failed to navigate to SSO URL. Retrying in 1 seconds...`)
      await new Promise(resolve => setTimeout(resolve, 1000))
      attempt++
    }
  }

  if (!loaded || redirectUrl == null) {
    throw new Error(
      `Failed to navigate to SSO URL after ${maxRetries} attempts.`
    )
  }

  return redirectUrl
}

/**
 * Sets the cookie for the cfx.re login.
 * @param browser
 * @param page
 * @returns {Promise<void>} Resolves when the cookie has been set.
 */
async function setForumCookie(browser: Browser, page: Page): Promise<void> {
  core.info('Setting cookies ...')

  const cookieValue = core.getInput('cookie')
  if (!cookieValue || cookieValue.trim() === '') {
    throw new Error(
      'FORUM_COOKIE secret is not set or empty.\n' +
        'Please add the FORUM_COOKIE secret to your repository:\n' +
        '1. Go to Settings → Secrets and variables → Actions\n' +
        '2. Click "New repository secret"\n' +
        '3. Name: FORUM_COOKIE, Value: your _t cookie from forum.cfx.re'
    )
  }

  await browser.setCookie({
    name: '_t',
    value: cookieValue,
    domain: 'forum.cfx.re',
    path: '/',
    expires: -1,
    size: 1,
    httpOnly: true,
    secure: true,
    session: false
  })

  await page.evaluate(() => document.write('Cookie' + document.cookie))

  core.info('Cookies set. Following redirect...')
}

/**
 * Gets the cookies from the browser.
 * @param browser
 * @returns {Promise<string>} Resolves with the cookies as a string.
 */
async function getCookies(browser: Browser): Promise<string> {
  return await browser
    .cookies()
    .then(cookies =>
      cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    )
}

/**
 * Retrieves the zipPath or creates a zip based on the provided parameters.
 * @param assetName - The name of the asset.
 * @param zipPath - The path to the zip file.
 * @param makeZip - Flag indicating whether to create a zip file.
 * @returns {Promise<string>} Resolves with the path to the zip file.
 * @throws If neither zipPath nor makeZip is provided, or if the pre-zip command fails.
 */
async function getZipPath(
  assetName: string,
  zipPath: string,
  makeZip: boolean,
  packageMode: string
): Promise<string> {
  core.debug('Zip path: ' + JSON.stringify(zipPath))
  if (zipPath.length > 0) {
    core.debug('Using provided zip path.')
    return zipPath
  }

  if (!makeZip && zipPath.length == 0) {
    throw new Error(
      'Either zipPath or makeZip must be provided to upload a file.'
    )
  }

  core.info('Creating zip file ...')

  // The runtime packer needs the Git index to select tracked files.
  if (packageMode === 'all') {
    deleteIfExists('.git/')
    deleteIfExists('.github/')
    deleteIfExists('.vscode/')
  }

  return zipAsset(assetName, packageMode)
}

/**
 * Starts the re-upload process by uploading the asset in chunks.
 * @param zipPath
 * @param assetId
 * @param chunkSize
 * @param cookies
 * @returns {Promise<void>} Resolves when the re-upload process is initiated successfully.
 * @throws If the re-upload fails due to errors in the response.
 */
async function startReupload(
  zipPath: string,
  assetId: string,
  chunkSize: number,
  cookies: string,
  version: string
): Promise<UploadedVersion> {
  const stats = statSync(zipPath)
  const totalSize = stats.size
  const originalFileName = basename(zipPath)
  const chunkCount = Math.ceil(totalSize / chunkSize)

  core.info('Starting upload ...')

  core.debug(`Total size: ${totalSize}`)
  core.debug(`Original file name: ${originalFileName}`)
  core.debug(`Chunk size: ${chunkSize}`)
  core.debug(`Chunk count: ${chunkCount}`)

  const reUploadReponse = await logPortalRequest(
    `POST /assets/${assetId}/re-upload (version=${version}, bytes=${totalSize}, chunks=${chunkCount})`,
    async () =>
      axios.post<ReUploadResponse>(
        getUrl('REUPLOAD', assetId),
        {
          chunk_count: chunkCount,
          chunk_size: chunkSize,
          name: originalFileName,
          original_file_name: originalFileName,
          total_size: totalSize,
          version
        },
        {
          headers: {
            Cookie: cookies
          }
        }
      ),
    [cookies]
  )

  if (reUploadReponse.data.errors !== null) {
    core.debug(JSON.stringify(reUploadReponse.data.errors))
    throw new Error(
      'Failed to re-upload file. See debug logs for more information.'
    )
  }
  const uploaded = parseUploadedVersion(reUploadReponse.data, assetId)
  core.info(
    `[CFX] Upload initialized: asset_id=${uploaded.assetId}, version_id=${uploaded.versionId}; file chunks still need uploading`
  )
  return uploaded
}

/**
 * Uploads a zip file in chunks to the specified asset.
 * @param zipPath
 * @param assetId
 * @param chunkSize.
 * @param cookies
 * @returns {Promise<void>} Resolves when the upload is complete.
 * @throws If the upload fails at any stage.
 */
async function uploadZip(
  zipPath: string,
  assetId: string,
  chunkSize: number,
  cookies: string,
  version: string
): Promise<UploadedVersion> {
  const uploaded = await startReupload(
    zipPath,
    assetId,
    chunkSize,
    cookies,
    version
  )

  const versionPath = `assets/${uploaded.assetId}/versions/${uploaded.versionId}`
  let chunkIndex = 0

  const stats = statSync(zipPath)
  const totalSize = stats.size
  const chunkCount = Math.ceil(totalSize / chunkSize)

  const stream = createReadStream(zipPath, { highWaterMark: chunkSize })

  for await (const chunk of stream) {
    const form = new FormData()
    form.append('chunk_id', chunkIndex)
    form.append('chunk', chunk, {
      filename: 'blob',
      contentType: 'application/octet-stream'
    })

    await logPortalRequest(
      `POST /${versionPath}/upload-chunk (chunk=${chunkIndex + 1}/${chunkCount}, chunk_id=${chunkIndex}, bytes=${(chunk as Buffer).length})`,
      async () =>
        axios.post(`${Urls.API}${versionPath}/upload-chunk`, form, {
          headers: {
            ...form.getHeaders(),
            Cookie: cookies
          }
        }),
      [cookies]
    )

    core.info(`Uploaded chunk ${chunkIndex + 1}/${chunkCount}`)

    chunkIndex++
  }

  await completeUpload(uploaded, cookies)
  return uploaded
}

/** Follow the Portal's create flow, which uses version-scoped chunk endpoints. */
async function createAsset(
  zipPath: string,
  assetName: string,
  version: string,
  chunkSize: number,
  cookies: string
): Promise<UploadedVersion> {
  const totalSize = statSync(zipPath).size
  if (!totalSize || chunkSize <= 0)
    throw new Error('Asset ZIP must be nonempty and chunkSize positive')
  const payload = {
    name: assetName,
    chunk_count: Math.ceil(totalSize / chunkSize),
    chunk_size: chunkSize,
    total_size: totalSize,
    original_file_name: basename(zipPath),
    release_candidate: false,
    version
  }
  core.info(`Creating asset with Portal payload: ${JSON.stringify(payload)}`)
  const response = await logPortalRequest(
    `POST /me/assets (name=${assetName}, version=${version}, bytes=${totalSize})`,
    async () =>
      axios.post<CreateAssetResponse>(`${Urls.API}me/assets`, payload, {
        headers: { Cookie: cookies }
      }),
    [cookies]
  )
  const { asset_id: assetId, version_id: versionId } = response.data
  if (!Number.isSafeInteger(assetId) || !Number.isSafeInteger(versionId)) {
    throw new Error(
      'Portal did not return an asset ID and version ID for the new asset'
    )
  }
  core.info(
    `[CFX] Asset initialized: asset_id=${assetId}, version_id=${versionId}; file chunks still need uploading`
  )
  const url = `${Urls.API}assets/${assetId}/versions/${versionId}`
  let index = 0
  for await (const chunk of createReadStream(zipPath, {
    highWaterMark: chunkSize
  })) {
    const form = new FormData()
    form.append('chunk_id', String(index))
    form.append('chunk', chunk, {
      filename: 'blob',
      contentType: 'application/octet-stream'
    })
    await logPortalRequest(
      `POST /assets/${assetId}/versions/${versionId}/upload-chunk (chunk_id=${index}, bytes=${(chunk as Buffer).length})`,
      async () =>
        axios.post(`${url}/upload-chunk`, form, {
          headers: { ...form.getHeaders(), Cookie: cookies }
        }),
      [cookies]
    )
    index++
  }
  await logPortalRequest(
    `POST /assets/${assetId}/versions/${versionId}/complete-upload`,
    async () =>
      axios.post(
        `${url}/complete-upload`,
        {},
        { headers: { Cookie: cookies } }
      ),
    [cookies]
  )
  core.info(
    `Created asset "${assetName}" (ID: ${assetId}, version: ${versionId})`
  )
  return { assetId, versionId }
}

/**
 * Completes the upload for the exact version returned by re-upload.
 * @param uploaded
 * @param cookies
 * @returns {Promise<void>} Resolves when the upload is complete.
 */
async function completeUpload(
  uploaded: UploadedVersion,
  cookies: string
): Promise<void> {
  const versionPath = `assets/${uploaded.assetId}/versions/${uploaded.versionId}`
  await logPortalRequest(
    `POST /${versionPath}/complete-upload`,
    async () =>
      axios.post(
        `${Urls.API}${versionPath}/complete-upload`,
        {},
        {
          headers: {
            Cookie: cookies
          }
        }
      ),
    [cookies]
  )

  core.info('Upload completed.')
}
