import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { pipeline } from 'stream/promises'
import { createGzip, createGunzip } from 'zlib'
import tar from 'tar-stream'
import { selectRuntimeFiles } from './manifest'
import { writeResourceZip } from './archive'
import { inspectResourceZip, InspectedZip, verifyWebFiles } from './inspect'
import { sourceFile, validateResourceName } from './paths'

async function hashFile(filename: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filename))
    hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function writeTar(
  root: string,
  output: string,
  resource: string,
  files: string[]
): Promise<void> {
  const pack = tar.pack()
  const writing = pipeline(pack, createGzip(), fs.createWriteStream(output))
  // Attach rejection handling before serial entry writes; await the original below.
  void writing.catch(() => {})
  try {
    for (const file of files) {
      const filename = sourceFile(root, file)
      const entry = pack.entry({
        name: `${resource}/${file}`,
        size: fs.statSync(filename).size,
        mode: 0o644,
        mtime: new Date(0)
      })
      await pipeline(fs.createReadStream(filename), entry)
    }
    pack.finalize()
    await writing
  } catch (error) {
    pack.destroy(error instanceof Error ? error : new Error(String(error)))
    await writing.catch(() => {})
    throw error
  }
}

export async function inspectRuntimeTar(
  filename: string
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >
  const extract = tar.extract()
  extract.on('entry', (header, stream, next) => {
    if (header.type !== 'file' || Object.hasOwn(hashes, header.name)) {
      extract.destroy(new Error(`Unexpected TAR entry: ${header.name}`))
      return
    }
    const hash = createHash('sha256')
    stream.on('error', error => extract.destroy(error))
    stream.on('data', (chunk: Buffer) => hash.update(chunk))
    stream.on('end', () => {
      hashes[header.name] = hash.digest('hex')
      next()
    })
  })
  await pipeline(fs.createReadStream(filename), createGunzip(), extract)
  return hashes
}

/** Build both archives in isolated staging and compare every archived file to its source. */
export async function createRuntimePackage(
  root: string,
  resource: string,
  webPath = ''
): Promise<{ directory: string; zipPath: string; result: InspectedZip }> {
  validateResourceName(resource)
  const files = selectRuntimeFiles(root, webPath)
  verifyWebFiles(
    files.map(file => `${resource}/${file}`),
    resource,
    webPath
  )
  const directory = fs.mkdtempSync(
    path.join(
      process.env.RUNNER_TEMP || os.tmpdir(),
      `cfx-runtime-${resource}-`
    )
  )
  const staging = path.join(directory, 'staging')
  try {
    const expected: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >
    for (const file of files) {
      const source = sourceFile(root, file)
      const target = path.join(staging, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const before = await hashFile(source)
      fs.copyFileSync(source, target)
      if ((await hashFile(target)) !== before)
        throw new Error(`Source changed while packaging: ${file}`)
      expected[`${resource}/${file}`] = before
    }
    const zipPath = await writeResourceZip(
      staging,
      path.join(directory, `${resource}-release.zip`),
      resource,
      files
    )
    const tarPath = path.join(directory, `${resource}.tar.gz`)
    await writeTar(staging, tarPath, resource, files)
    const result = await inspectResourceZip(zipPath, resource)
    const tarHashes = await inspectRuntimeTar(tarPath)
    for (const hashes of [result.hashes, tarHashes]) {
      if (
        Object.keys(hashes).length !== files.length ||
        Object.entries(expected).some(([file, hash]) => hashes[file] !== hash)
      ) {
        throw new Error(
          'Archive contents do not match the selected source files'
        )
      }
    }
    // Check the original files again, not only the staging copy.
    for (const file of files) {
      if (
        (await hashFile(sourceFile(root, file))) !==
        expected[`${resource}/${file}`]
      )
        throw new Error(`Source changed while packaging: ${file}`)
    }
    fs.rmSync(staging, { recursive: true, force: true })
    return { directory, zipPath, result }
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
