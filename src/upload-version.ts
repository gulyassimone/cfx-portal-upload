import { UploadedVersion } from './types'

/** Fail closed instead of deploying an unrelated active version. */
export function parseUploadedVersion(
  response: unknown,
  requestedAssetId: string
): UploadedVersion {
  const data = response as { asset_id?: unknown; version_id?: unknown } | null
  const assetId = data?.asset_id
  const versionId = data?.version_id
  if (
    typeof assetId !== 'number' ||
    !Number.isSafeInteger(assetId) ||
    assetId <= 0 ||
    typeof versionId !== 'number' ||
    !Number.isSafeInteger(versionId) ||
    versionId <= 0 ||
    String(assetId) !== requestedAssetId
  ) {
    throw new Error(
      'CFX re-upload response has missing or mismatched asset_id/version_id; deployment is blocked.'
    )
  }
  return { assetId, versionId }
}
