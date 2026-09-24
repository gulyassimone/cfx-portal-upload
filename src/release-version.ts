/** Read exactly one literal semantic version declaration. */
function declaration(manifest: string): RegExpMatchArray {
  const declarations = [...manifest.matchAll(/^\s*version\b[^\r\n]*$/gm)]
  if (declarations.length !== 1)
    throw new Error(
      'Expected exactly one version declaration in fxmanifest.lua'
    )
  const match = declarations[0][0].match(
    /^\s*version\s+(['"])(\d+\.\d+\.\d+)\1\s*$/
  )
  if (!match)
    throw new Error(
      'Expected a literal MAJOR.MINOR.PATCH version in fxmanifest.lua'
    )
  return match
}

export function readReleaseVersion(manifest: string): string {
  return declaration(manifest)[2]
}

export function setRunVersion(
  manifest: string,
  runNumber: string,
  attempt: string
): { manifest: string; version: string } {
  if (![runNumber, attempt].every(value => /^[1-9]\d*$/.test(value))) {
    throw new Error('Release run number and attempt must be positive integers')
  }
  if (!/^\s*version\b/m.test(manifest)) {
    const version = `1.${runNumber}.${attempt}`
    return {
      manifest: `${manifest.trimEnd()}\nversion '${version}'\n`,
      version
    }
  }
  const old = readReleaseVersion(manifest)
  const version = `${old.split('.')[0]}.${runNumber}.${attempt}`
  return {
    manifest: manifest.replace(
      declaration(manifest)[0],
      `version '${version}'`
    ),
    version
  }
}
