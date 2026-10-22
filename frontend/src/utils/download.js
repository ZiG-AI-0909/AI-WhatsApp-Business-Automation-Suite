/**
 * Save a file response (Excel / PDF export) in the browser. Uses the
 * server's Content-Disposition file name when present.
 * Throws with `.status` for a failed response, like apiFetch.
 */
export async function downloadResponse(response, fallbackName) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const error = new Error(body.error || `Download failed (${response.status})`)
    error.status = response.status
    if (typeof body.code === 'string') error.code = body.code
    throw error
  }
  const disposition = response.headers.get('content-disposition') || ''
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] || fallbackName
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
