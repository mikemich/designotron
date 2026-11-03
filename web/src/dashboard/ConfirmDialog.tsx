import { useDialog } from "../ui/controls";

/** An in-page yes/no question (never the browser's confirm): Escape cancels, focus starts on Cancel. */
export function ConfirmDialog(props: { title: string; message: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  const ref = useDialog(props.onCancel);
  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div ref={ref} className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-msg">
        <div className="modal-head">
          <b id="confirm-title">{props.title}</b>
        </div>
        <div className="confirm-body" id="confirm-msg">
          {props.message}
        </div>
        <div className="confirm-actions">
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn primary danger" onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
