import { useEffect } from 'react'

export default function Toast({ message, kind = 'error', onDismiss }) {
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => onDismiss?.(), 5000)
    return () => clearTimeout(t)
  }, [message, onDismiss])

  if (!message) return null

  const styles =
    kind === 'error'
      ? 'border-red-500/40 bg-red-500/15 text-red-200'
      : 'border-indigo-500/40 bg-indigo-500/15 text-indigo-100'

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      <div
        className={
          'pointer-events-auto flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm shadow-lg ' +
          styles
        }
      >
        <span>{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-current/70 hover:text-current"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
