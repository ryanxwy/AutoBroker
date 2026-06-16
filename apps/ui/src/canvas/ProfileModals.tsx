/**
 * ProfileModals — the two profile dialogs hosted by App:
 *
 *   - ProfileEditModal: the UNIFIED preference-edit surface (opened from both the
 *     Canvas profile card AND the Searches list "view profile"). It wraps the
 *     existing ProfileEditPanel verbatim (the safe-fields contract, frozen
 *     identity, and budget red-line are untouched) in the dialog-variant Modal,
 *     plus a "Danger zone" that escalates to the hard delete.
 *
 *   - HardDeleteModal: the IRREVERSIBLE confirm (danger-variant alertdialog). A
 *     simple two-button confirm (Cancel focused by default; backdrop click and
 *     Escape route to cancel only). On confirm the host calls client.purgeProfile.
 *     Distinct from the recoverable soft "Remove" (ProfileRemoveControl).
 */

import { useId } from "react";

import type { ApiClient } from "../api/client.js";
import { Modal } from "../shell/Modal.js";
import { ProfileEditPanel } from "./ProfileEditPanel.js";

export function ProfileEditModal({
  client,
  profileId,
  name,
  open,
  onClose,
  onDeleteRequest,
}: {
  client: ApiClient;
  profileId: string;
  name: string;
  open: boolean;
  onClose: () => void;
  /** Escalate to the hard-delete confirm (App swaps the modal). */
  onDeleteRequest: () => void;
}): JSX.Element {
  const titleId = useId();
  return (
    <Modal open={open} onClose={onClose} labelId={titleId} variant="dialog">
      <h2 id={titleId} data-testid="profile-edit-modal-title">
        Search preferences{name !== "" ? ` — ${name}` : ""}
      </h2>
      <ProfileEditPanel client={client} profileId={profileId} onSaved={onClose} onCancel={onClose} />
      <div className="profile-danger-zone">
        <button
          type="button"
          className="btn-danger"
          data-testid="profile-edit-delete"
          onClick={onDeleteRequest}
        >
          Delete permanently…
        </button>
      </div>
    </Modal>
  );
}

export function HardDeleteModal({
  open,
  name,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  name: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const titleId = useId();
  const descId = useId();
  return (
    <Modal open={open} onClose={onClose} labelId={titleId} describedById={descId} variant="danger">
      <h2 id={titleId} className="danger-text" data-testid="hard-del-title">
        Delete “{name}” permanently?
      </h2>
      <p id={descId} className="hard-delete-consequence">
        This permanently erases <strong>all local data</strong> for this search — its dealers,
        quotes, dealer replies, and history. <strong>This cannot be undone.</strong> To keep your
        data instead, use “Remove” (it can be restored from Closed searches).
      </p>
      {error !== null && (
        <p className="danger-text" role="alert" data-testid="hard-del-error">
          Couldn’t delete: {error}
        </p>
      )}
      <div className="modal-foot">
        <button type="button" data-testid="hard-del-cancel" disabled={busy} onClick={onClose}>
          Cancel, keep it
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn-danger"
          data-testid="hard-del-confirm"
          aria-busy={busy}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Deleting…" : "Permanently delete"}
        </button>
      </div>
    </Modal>
  );
}
