import * as core from '@actions/core'

/** Shared by deployment and rollback; keep path defaults in one place. */
export function getDeployPaths(): { deployPath: string; backupPath: string } {
  return {
    deployPath: core.getInput('deploy_path') || '/sftp/deploy/resources',
    backupPath:
      core.getInput('deploy_backup_path') || '~/.cfx-portal-upload/backups'
  }
}
