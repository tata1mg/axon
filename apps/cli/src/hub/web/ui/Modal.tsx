import { type ReactNode, useEffect, useRef } from "react";
import "./modal.css";

interface ModalProps {
  /** Escape or a close request. The owner decides whether to unmount. */
  readonly onDismiss: () => void;
  /** Element id to focus once the dialog is shown. */
  readonly initialFocus?: string;
  readonly small?: boolean;
  readonly labelledBy: string;
  readonly describedBy?: string;
  readonly children: ReactNode;
}

/**
 * Native modal `<dialog>`: the browser provides the top layer, inert background, and focus trap.
 * Open it by mounting and close it by unmounting; focus returns to where it was.
 */
export function Modal({
  onDismiss,
  initialFocus,
  small,
  labelledBy,
  describedBy,
  children,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const focusOnOpen = useRef(initialFocus);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement;
    dialog.showModal();
    const target = focusOnOpen.current ? document.getElementById(focusOnOpen.current) : null;
    target?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={small ? "modal modal-small" : "modal"}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
    >
      {children}
    </dialog>
  );
}
