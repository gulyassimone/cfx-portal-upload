import * as core from '@actions/core'
import axios from 'axios'
import { logPortalRequest } from './portal-log'
import { PortalAsset, Urls } from './types'

/** Oldest creation ID wins; never remove the only downloadable version. */
export function oldestRemovableVersion(asset: PortalAsset): number | undefined {
  if (!Array.isArray(asset.versions))
    throw new Error('Portal did not return a version list; refusing to delete')
  if (asset.versions.length < 2) return undefined
  const ids = asset.versions.map(version => version.id)
  if (
    ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  )
    throw new Error('Portal returned invalid or duplicate version IDs')
  const oldest = Math.min(...ids)
  const remainingDownloadable = asset.versions.some(
    version =>
      version.id !== oldest &&
      version.state === 'active' &&
      Array.isArray(version.packs) &&
      version.packs.length > 0
  )
  if (!remainingDownloadable)
    throw new Error(
      `Cannot delete oldest version ${oldest}: no other active downloadable version would remain`
    )
  return oldest
}

/** Pre-upload stage for an existing asset only. */
export async function pruneOldestVersion(
  assetId: string,
  cookie: string,
  uploadingVersion: string
): Promise<void> {
  const id = Number(assetId)
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error(`Invalid Portal asset ID: ${assetId}`)
  const url = `${Urls.API}assets/${id}`
  const response = await logPortalRequest(
    `GET /assets/${id} (pre-upload version inventory)`,
    async () => axios.get<PortalAsset>(url, { headers: { Cookie: cookie } }),
    [cookie]
  )
  const asset = response.data
  if (asset?.id !== id)
    throw new Error('Portal asset ID changed; refusing to delete a version')
  if (asset.versions?.some(version => version.version === uploadingVersion))
    throw new Error(
      `Version ${uploadingVersion} already exists on asset ${id}; refusing to delete another version`
    )
  const oldest = oldestRemovableVersion(asset)
  if (oldest === undefined) {
    core.info(
      `[CFX] Asset ${id} has ${asset.versions.length} version(s); skipping pre-upload deletion`
    )
    return
  }
  core.info(
    `[CFX] Deleting oldest version ${oldest} from asset ${id} before upload (${asset.versions.length} versions)`
  )
  await logPortalRequest(
    `DELETE /assets/${id}/versions/${oldest}`,
    async () =>
      axios.delete(`${url}/versions/${oldest}`, {
        headers: { Cookie: cookie }
      }),
    [cookie]
  )
}
