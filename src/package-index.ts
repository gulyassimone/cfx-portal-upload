import * as core from '@actions/core'
import { runPackage } from './packaging/action'

void runPackage().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error))
})
