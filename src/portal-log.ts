import * as core from '@actions/core'
import { AxiosResponse } from 'axios'

/** Log request boundaries without dumping Axios config, cookies or signed URLs. */
export async function logPortalRequest<T>(
  label: string,
  request: () => Promise<AxiosResponse<T>>,
  secrets: string[] = []
): Promise<AxiosResponse<T>> {
  const started = Date.now()
  core.info(`[CFX] ${label} - starting`)
  try {
    const response = await request()
    core.info(
      `[CFX] ${label} - HTTP ${response.status ?? 'unknown'} (${Date.now() - started} ms)`
    )
    return response
  } catch (error) {
    // Only select diagnostic fields; never serialize the request/config/headers.
    const failure = error as {
      code?: string
      response?: {
        status?: number
        data?: unknown
        headers?: Record<string, unknown>
      }
    } | null
    const response = failure?.response
    const status = response?.status ?? 'no HTTP response'
    core.error(`[CFX] ${label} - HTTP ${status} (${Date.now() - started} ms)`)
    if (failure?.code)
      core.error(`[CFX] Network code: ${safePreview(failure.code, secrets)}`)
    if (response) {
      for (const name of [
        'content-type',
        'retry-after',
        'x-request-id',
        'cf-ray'
      ]) {
        const value = response.headers?.[name]
        if (value !== undefined)
          core.info(`[CFX] ${name}: ${safePreview(value, secrets)}`)
      }
      core.error(`[CFX] Response body: ${safePreview(response.data, secrets)}`)
    }
    if (response?.status === 503 || response?.status === 409) {
      core.warning(
        '[CFX] Check this asset/version in Portal before rerunning: a version record may exist even when file upload failed.'
      )
    }
    throw error
  }
}

function safePreview(value: unknown, secrets: string[]): string {
  if (value === undefined) return '(empty)'
  if (Buffer.isBuffer(value) || value instanceof ArrayBuffer) {
    return '(binary response omitted)'
  }
  let text: string
  try {
    text =
      typeof value === 'string'
        ? value
        : JSON.stringify(value, (key: string, item: unknown) =>
            /cookie|authorization|token|secret|password|signature|signed|url/i.test(
              key
            )
              ? '[REDACTED]'
              : item
          )
  } catch {
    return '(unserializable response omitted)'
  }
  if (typeof text !== 'string') return '(empty)'
  for (const secret of secrets.filter(Boolean)) {
    text = text.split(secret).join('[REDACTED]')
    // Cookie headers contain several independently sensitive values.
    for (const part of secret.split(';')) {
      const separator = part.indexOf('=')
      const cookieValue = part.slice(separator + 1).trim()
      if (separator >= 0 && cookieValue)
        text = text.split(cookieValue).join('[REDACTED]')
    }
  }
  text = text
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL REDACTED]')
    .replace(
      /((?:cookie|authorization|token|secret|password|signature)\s*[:=]\s*)[^\s,;<>]+/gi,
      '$1[REDACTED]'
    )
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
  return text.length > 3000 ? `${text.slice(0, 3000)}… (truncated)` : text
}
