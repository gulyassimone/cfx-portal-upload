import fs from 'fs'
import path from 'path'
import * as lua from 'luaparse'
import { minimatch } from 'minimatch'
import { listFiles, sourceFile, validateRelativePath } from './paths'

type Literal = string | string[]
const FILE_DIRECTIVES = new Set([
  'client_script',
  'client_scripts',
  'server_script',
  'server_scripts',
  'shared_script',
  'shared_scripts',
  'file',
  'files',
  'ui_page',
  'loadscreen',
  'before_level_meta',
  'after_level_meta'
])

/** Parse declarations without executing Lua or invoking anything from the resource. */
export function manifestReferences(manifest: string): string[] {
  // Lua strings contain bytes. Preserve UTF-8 filenames when parsing escape sequences.
  const ast = lua.parse(Buffer.from(manifest, 'utf8').toString('latin1'), {
    luaVersion: '5.3',
    encodingMode: 'pseudo-latin1',
    comments: false
  })
  const locals = new Map<string, Literal>()
  function literal(expression: lua.Expression): Literal {
    if (expression.type === 'StringLiteral')
      return Buffer.from(expression.value, 'latin1').toString('utf8')
    if (expression.type === 'Identifier' && locals.has(expression.name))
      return locals.get(expression.name) as Literal
    if (
      expression.type === 'BinaryExpression' &&
      expression.operator === '..'
    ) {
      const left = literal(expression.left),
        right = literal(expression.right)
      if (typeof left === 'string' && typeof right === 'string')
        return left + right
    }
    if (expression.type === 'TableConstructorExpression') {
      return expression.fields.flatMap(field => {
        if (field.type !== 'TableValue')
          throw new Error('Manifest file lists must be array tables')
        const value = literal(field.value)
        if (typeof value !== 'string')
          throw new Error('Nested manifest file lists are not supported')
        return [value]
      })
    }
    throw new Error(
      `Cannot statically resolve manifest value (${expression.type}); use literal file paths or custom packaging`
    )
  }
  function call(expression: lua.Expression): {
    name: string
    args: lua.Expression[]
  } {
    if (expression.type === 'Identifier')
      return { name: expression.name, args: [] }
    if (
      expression.type === 'CallExpression' ||
      expression.type === 'StringCallExpression' ||
      expression.type === 'TableCallExpression'
    ) {
      const base = call(expression.base)
      const args =
        expression.type === 'CallExpression'
          ? expression.arguments
          : expression.type === 'StringCallExpression'
            ? [expression.argument]
            : [expression.arguments]
      return { name: base.name, args: [...base.args, ...args] }
    }
    throw new Error(
      'Dynamic manifest calls are not supported; use literal declarations or custom packaging'
    )
  }
  const references: string[] = []
  for (const statement of ast.body) {
    if (statement.type === 'LocalStatement') {
      const values = statement.init.map(literal)
      if (values.length !== statement.variables.length)
        throw new Error('Uninitialized manifest variables are not supported')
      statement.variables.forEach((variable, index) =>
        locals.set(variable.name, values[index])
      )
    } else if (statement.type === 'CallStatement') {
      const invocation = call(statement.expression)
      if (invocation.name === 'data_file') {
        const args = invocation.args.map(literal)
        if (
          args.length !== 2 ||
          typeof args[0] !== 'string' ||
          typeof args[1] !== 'string'
        )
          throw new Error('data_file requires a literal type and filename')
        references.push(args[1])
      } else if (FILE_DIRECTIVES.has(invocation.name)) {
        if (invocation.args.length !== 1)
          throw new Error(`Unexpected arguments for ${invocation.name}`)
        for (const reference of [literal(invocation.args[0])].flat()) {
          if (
            (invocation.name === 'ui_page' ||
              invocation.name === 'loadscreen') &&
            /^https?:\/\//i.test(reference)
          )
            continue
          references.push(reference)
        }
      }
      // Other declarations (dependency, escrow_ignore, exports, author...) are metadata,
      // not file inclusion rules.
    } else {
      throw new Error(
        `Dynamic manifest statement ${statement.type} is not supported; use custom packaging`
      )
    }
  }
  return references.filter(reference => !reference.startsWith('@'))
}

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.github',
  '.vscode',
  '.idea',
  '.devcontainer',
  '.agents',
  '.codex',
  'node_modules',
  'tests',
  'test',
  '__tests__'
])
function forbidden(file: string, webPath: string): boolean {
  const base = path.posix.basename(file).toLowerCase()
  const webSource = webPath ? `${path.posix.dirname(webPath)}/src/` : 'web/src/'
  return (
    file.split('/').some(part => EXCLUDED_DIRECTORIES.has(part)) ||
    file.startsWith('web/src/') ||
    file.startsWith(webSource) ||
    /^(readme(?:\..*)?|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.env(?:\..*)?)$/.test(
      base
    ) ||
    /\.(map|zip|tar|gz|tgz|rar|7z)$/.test(base)
  )
}

/** Manifest selection plus common runtime conventions; no directory-wide source copy. */
export function selectRuntimeFiles(root: string, webPath = ''): string[] {
  if (webPath) validateRelativePath(webPath)
  const manifest = sourceFile(root, 'fxmanifest.lua')
  const references = manifestReferences(fs.readFileSync(manifest, 'utf8'))
  const files = listFiles(root, [
    ...EXCLUDED_DIRECTORIES,
    'web/src',
    ...(webPath ? [`${path.posix.dirname(webPath)}/src`] : [])
  ])
  const available = files.filter(file => !forbidden(file, webPath))
  const selected = new Set(['fxmanifest.lua'])
  for (const reference of references) {
    validateRelativePath(reference)
    // CFX treats **.lua as recursive, unlike minimatch's same-directory **.lua.
    const pattern = reference.replace(/(^|\/)\*\*(?=[^/])/g, '$1**/*')
    const matches = available.filter(
      file =>
        file === reference ||
        file.startsWith(`${reference}/`) ||
        minimatch(file, pattern, {
          dot: true,
          nonegate: true,
          nocomment: true,
          noext: true,
          nobrace: true
        })
    )
    if (matches.length === 0)
      throw new Error(
        `Manifest reference has no allowed runtime files: ${reference}`
      )
    matches.forEach(file => selected.add(file))
  }
  // FiveM streams assets from this conventional directory without individual declarations.
  available
    .filter(file => file.startsWith('stream/'))
    .forEach(file => selected.add(file))
  for (const sql of ['install/schema.sql', 'install/seed.sql']) {
    if (files.includes(sql)) selected.add(sql)
  }
  for (const file of selected) sourceFile(root, file)
  return [...selected].sort()
}
