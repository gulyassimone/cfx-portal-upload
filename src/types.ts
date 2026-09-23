export interface ReUploadResponse {
  asset_id: number
  version_id: number
  errors: null
}

export interface Asset {
  id: number
  name: string
}

export interface SearchResponse {
  items: Asset[]
}

export interface SSOResponseBody {
  url: string
}

export enum Urls {
  API = 'https://portal-api.cfx.re/v1/',
  SSO = 'auth/discourse?return=',
  REUPLOAD = 'assets/{id}/re-upload',
  UPLOAD_CHUNK = 'assets/{id}/upload-chunk',
  COMPLETE_UPLOAD = 'assets/{id}/complete-upload'
}

export interface CreateAssetResponse {
  asset_id: number
  version_id: number
}

export interface AssetConfig {
  asset_id?: string
  asset_name?: string
}

export type VersionType = 'escrowed' | 'opensource'

export interface VersionConfig {
  type: VersionType
  assetName: string
  resourcePath?: string
}

export interface BuildOptions {
  createEscrowed: boolean
  createOpenSource: boolean
  escrowedConfig?: AssetConfig
  openSourceConfig?: AssetConfig
  resourcePath?: string
}

export interface ZipPaths {
  escrowed?: string
  openSource?: string
}

export interface SSHConfig {
  host: string
  port: number
  username: string
  privateKey: string
}

export interface DeployConfig {
  enabled: boolean
  sshConfig?: SSHConfig
  deployPath: string
  resourceName?: string
  backupPath: string
}

export interface AssetVersionInfo {
  assetId: number
  versionId: number
  packId: number
}

export interface PortalAsset {
  id: number
  name: string
  state: string
  versions: {
    id: number
    state: string
    packs: { id: number; game: string }[]
  }[]
}

export interface PortalAssetsResponse {
  items: PortalAsset[]
  page: number
  page_count: number
}

/** Identity returned when CFX creates the version for this upload. */
export interface UploadedVersion {
  assetId: number
  versionId: number
}
