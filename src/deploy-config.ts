import * as core from '@actions/core'

/** Shared path configuration for deployment and rollback. */
export function getDeployPaths(required: boolean): {
  deployPath: string
  backupPath: string
} {
  const deployPath = core.getInput('deploy_path').trim()
  if (required && !deployPath) {
    throw new Error('deploy_path is required for deployment or rollback.')
  }
  return {
    deployPath,
    backupPath:
      core.getInput('deploy_backup_path') || '~/.cfx-portal-upload/backups'
  }
}
