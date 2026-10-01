import { useRef, useState, type ReactNode } from 'react'

function encodeText(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function DownloadButton({ filename, mimeType, content, encoding = 'utf8', className, children }: { filename: string; mimeType: string; content: string; encoding?: 'utf8' | 'base64'; className?: string; children: ReactNode }) {
  const [saving, setSaving] = useState(false)
  const [savedPath, setSavedPath] = useState('')
  const [error, setError] = useState('')
  const pending = useRef(false)
  const save = async () => {
    if (pending.current) return
    pending.current = true
    setSaving(true); setError(''); setSavedPath('')
    try {
      const app = window.go?.main?.App
      if (!app?.SaveDownload) throw new Error('下载接口不可用，请使用新版 Lake 桌面应用')
      const path = await app.SaveDownload(filename, mimeType, encoding === 'base64' ? content : encodeText(content))
      if (path) setSavedPath(path)
    } catch (cause) { setError(String(cause)) }
    finally { pending.current = false; setSaving(false) }
  }
  return <span className={'download-control ' + (className ?? '')}>
    <button type="button" className="download-button" disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : children}</button>
    {savedPath && <span className="download-status" role="status" title={savedPath}>已保存</span>}
    {error && <span className="download-error" role="alert">{error}</span>}
  </span>
}
