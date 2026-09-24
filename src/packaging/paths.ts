import fs from 'fs'
import path from 'path'

export function validateResourceName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error('resource-name must contain only letters, digits, _ and -')
  }
}

export function validateRelativePath(name: string): void {
  if (
    !name ||
    name.includes('\\') ||
    name.includes(':') ||
    /[\r\n\0]/.test(name) ||
    name.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid relative path: ${name}`)
  }
}

/** Resolve existing files without following symlinks, including parent directories. */
export function sourceFile(root: string, relative: string): string {
  validateRelativePath(relative)
  let current = path.resolve(root)
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink())
      throw new Error(`Symlink rejected: ${relative}`)
  }
  if (!fs.statSync(current).isFile()) throw new Error(`Not a file: ${relative}`)
  return current
}

export function listFiles(root: string, excluded: string[] = []): string[] {
  const files: string[] = []
  function visit(relative: string): void {
    for (const entry of fs.readdirSync(path.join(root, relative), {
      withFileTypes: true
    })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (
        excluded.some(
          item =>
            name === item ||
            name.startsWith(`${item}/`) ||
            (!item.includes('/') && entry.name === item)
        )
      )
        continue
      if (entry.isSymbolicLink()) throw new Error(`Symlink rejected: ${name}`)
      if (entry.isDirectory()) visit(name)
      else if (entry.isFile()) files.push(name)
      else throw new Error(`Unsupported file: ${name}`)
    }
  }
  visit('')
  return files.sort()
}
