import { formatTime } from '../utils/format.js'

function TBtn({ onClick, disabled, title, children, tone = 'default' }) {
  const tones = {
    default:
      'border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100',
    danger:
      'border-rose-900/70 text-rose-300 hover:border-rose-600 hover:text-rose-200',
    accent:
      'border-indigo-700/70 text-indigo-300 hover:border-indigo-500 hover:text-indigo-100',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        'flex h-7 items-center gap-1 rounded-md border bg-zinc-900/60 px-2 text-xs font-medium transition ' +
        (disabled
          ? 'cursor-not-allowed border-zinc-800 text-zinc-600 opacity-60'
          : tones[tone])
      }
    >
      {children}
    </button>
  )
}

const Divider = () => <div className="mx-1 h-5 w-px bg-zinc-800" />

/**
 * The editor toolbar: zoom controls on the left, edit + history actions on the
 * right, with a live readout of the current selection and kept duration.
 */
export default function EditorToolbar({
  // zoom
  onZoomIn,
  onZoomOut,
  onFit,
  canZoomIn,
  canZoomOut,
  // edit
  onTrim,
  onDeleteSel,
  onSplit,
  onDeleteClip,
  onUndo,
  onRedo,
  hasSelection,
  hasActiveClip,
  canUndo,
  canRedo,
  // readout
  selection,
  isEdited,
  keptDuration,
  duration,
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 bg-zinc-950/40 px-2 py-1.5">
      {/* Zoom */}
      <TBtn onClick={onZoomOut} disabled={!canZoomOut} title="Zoom out (−)">
        <span className="text-sm leading-none">−</span>
      </TBtn>
      <TBtn onClick={onZoomIn} disabled={!canZoomIn} title="Zoom in (+)">
        <span className="text-sm leading-none">+</span>
      </TBtn>
      <TBtn onClick={onFit} title="Fit timeline to width">
        Fit
      </TBtn>

      <Divider />

      {/* Edit actions */}
      <TBtn onClick={onTrim} disabled={!hasSelection} title="Trim to selection">
        Trim
      </TBtn>
      <TBtn
        onClick={onDeleteSel}
        disabled={!hasSelection}
        title="Delete selection (Del)"
        tone="danger"
      >
        Delete
      </TBtn>
      <TBtn onClick={onSplit} title="Split at playhead (S)">
        Split
      </TBtn>
      <TBtn
        onClick={onDeleteClip}
        disabled={!hasActiveClip}
        title="Delete the selected match clip"
        tone="danger"
      >
        Del clip
      </TBtn>

      <Divider />

      {/* History */}
      <TBtn onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
        Undo
      </TBtn>
      <TBtn onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
        Redo
      </TBtn>

      {/* Readout */}
      <div className="ml-auto flex items-center gap-3 pr-1 font-mono text-[11px] tabular-nums">
        {selection ? (
          <span className="text-emerald-300">
            sel {formatTime(selection.start)}–{formatTime(selection.end)}
            <span className="ml-1 text-emerald-500/70">
              ({formatTime(selection.end - selection.start)})
            </span>
          </span>
        ) : (
          <span className="text-zinc-600">drag timeline to select</span>
        )}
        {isEdited && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">
            edited · {formatTime(keptDuration)} / {formatTime(duration)}
          </span>
        )}
      </div>
    </div>
  )
}
