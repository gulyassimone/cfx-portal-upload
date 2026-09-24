import fs from 'fs'
import { createHash } from 'crypto'
import yauzl from 'yauzl'
import { readReleaseVersion } from '../release-version'
import { validateRelativePath, validateResourceName } from './paths'

export interface InspectedZip {
  version: string
  files: string[]
  hashes: Record<string, string>
  sha256: string
}

/** Reads every file without extracting; rejects ambiguous roots, links and duplicate entries. */
export async function inspectResourceZip(
  zipPath: string,
  resourceName: string
): Promise<InspectedZip> {
  validateResourceName(resourceName)
  const result = await new Promise<Omit<InspectedZip, 'sha256'>>(
    (resolve, reject) => {
      yauzl.open(
        zipPath,
        { lazyEntries: true, strictFileNames: true },
        (error, zip) => {
          if (error) {
            reject(error)
            return
          }
          const names = new Set<string>()
          const hashes: Record<string, string> = Object.create(null) as Record<
            string,
            string
          >
          let manifest: string | undefined
          function fail(reason: unknown): void {
            zip.close()
            reject(reason instanceof Error ? reason : new Error(String(reason)))
          }
          zip.on('error', fail)
          zip.on('entry', (entry: yauzl.Entry) => {
            try {
              const directory = entry.fileName.endsWith('/')
              const name = directory
                ? entry.fileName.slice(0, -1)
                : entry.fileName
              validateRelativePath(name)
              if (name !== resourceName && !name.startsWith(`${resourceName}/`))
                throw new Error(`Unexpected ZIP root: ${name}`)
              if (!directory && name === resourceName)
                throw new Error('Resource root must be a directory')
              if (names.has(name))
                throw new Error(`Duplicate ZIP entry: ${name}`)
              names.add(name)
              const kind = (entry.externalFileAttributes >>> 16) & 0o170000
              if (kind !== 0 && kind !== (directory ? 0o040000 : 0o100000))
                throw new Error(`Non-regular ZIP entry: ${name}`)
              if (entry.isEncrypted())
                throw new Error(`Encrypted ZIP entry: ${name}`)
              if (directory) {
                zip.readEntry()
                return
              }
              const isManifest = name === `${resourceName}/fxmanifest.lua`
              if (isManifest && entry.uncompressedSize > 1024 * 1024)
                throw new Error('Manifest exceeds 1 MiB')
              zip.openReadStream(entry, (streamError, stream) => {
                if (streamError) {
                  fail(streamError)
                  return
                }
                const hash = createHash('sha256')
                const chunks: Buffer[] = []
                stream.on('error', fail)
                stream.on('data', (chunk: Buffer) => {
                  hash.update(chunk)
                  if (isManifest) chunks.push(chunk)
                })
                stream.on('end', () => {
                  hashes[name] = hash.digest('hex')
                  if (isManifest)
                    manifest = Buffer.concat(chunks).toString('utf8')
                  zip.readEntry()
                })
              })
            } catch (reason) {
              fail(reason)
            }
          })
          zip.on('end', () => {
            try {
              if (manifest === undefined)
                throw new Error(`Missing ${resourceName}/fxmanifest.lua in ZIP`)
              resolve({
                version: readReleaseVersion(manifest),
                files: Object.keys(hashes).sort(),
                hashes
              })
            } catch (reason) {
              reject(
                reason instanceof Error ? reason : new Error(String(reason))
              )
            }
          })
          zip.readEntry()
        }
      )
    }
  )
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(zipPath))
    hash.update(chunk as Buffer)
  return { ...result, sha256: hash.digest('hex') }
}

export function verifyWebFiles(
  files: string[],
  resourceName: string,
  webPath: string
): void {
  if (!webPath) return
  validateRelativePath(webPath)
  const prefix = `${resourceName}/${webPath}/`
  if (
    !files.includes(`${prefix}index.html`) ||
    !files.some(file => file.startsWith(prefix) && file.endsWith('.js')) ||
    !files.some(file => file.startsWith(prefix) && file.endsWith('.css'))
  ) {
    throw new Error(`Missing production index.html, JS or CSS in ${webPath}`)
  }
}
