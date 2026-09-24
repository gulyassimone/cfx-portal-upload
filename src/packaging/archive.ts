import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import yazl from 'yazl'
import { listFiles, sourceFile, validateResourceName } from './paths'

/** ZIP writer only: callers own the policy selecting runtime files. */
export async function writeResourceZip(
  sourceDir: string,
  destination: string,
  resourceName: string,
  files = listFiles(sourceDir)
): Promise<string> {
  validateResourceName(resourceName)
  const output = path.resolve(destination)
  const selected = [...new Set(files)].sort().map(relative => ({
    relative,
    absolute: sourceFile(sourceDir, relative)
  }))
  if (selected.some(file => file.absolute === output)) {
    throw new Error('Output ZIP must not be one of the input files')
  }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const zip = new yazl.ZipFile()
  for (const file of selected) {
    zip.addFile(file.absolute, `${resourceName}/${file.relative}`, {
      compress: true
    })
  }
  const finished = pipeline(zip.outputStream, fs.createWriteStream(output))
  zip.on('error', (error: Error) =>
    (zip.outputStream as Readable).destroy(error)
  )
  zip.end()
  await finished
  return output
}
