import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon.tsx";
import { Modal } from "./Modal.tsx";
import "./feedback.css";

/* ---------- Toasts ---------- */

export interface ToastOptions {
  readonly tone?: "success" | "error";
  readonly action?: { readonly label: string; readonly run: () => void };
}
type Toast = (message: string, options?: ToastOptions) => void;

interface ToastItem extends ToastOptions {
  readonly id: number;
  readonly message: string;
}

/* ---------- Confirm ---------- */

export interface ConfirmOptions {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly tone?: "primary" | "danger";
}
type Confirm = (options: ConfirmOptions) => Promise<boolean>;

interface Feedback {
  readonly toast: Toast;
  readonly confirm: Confirm;
}

const FeedbackContext = createContext<Feedback | null>(null);

export function useFeedback(): Feedback {
  const feedback = useContext(FeedbackContext);
  if (!feedback) throw new Error("useFeedback needs a <FeedbackProvider>.");
  return feedback;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<
    (ConfirmOptions & { resolve: (value: boolean) => void }) | null
  >(null);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback<Toast>((message, options = {}) => {
    const id = nextId.current++;
    setToasts((items) => [...items, { id, message, ...options }]);
  }, []);

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise((resolve) => {
        setPendingConfirm({ ...options, resolve });
      }),
    [],
  );

  const settle = (value: boolean) => {
    pendingConfirm?.resolve(value);
    setPendingConfirm(null);
  };

  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((item) => (
          <ToastView key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
      {pendingConfirm && (
        <Modal
          small
          labelledBy="confirm-title"
          describedBy="confirm-body"
          initialFocus="confirm-cancel"
          onDismiss={() => settle(false)}
        >
          <div className="modal-body">
            <h2 id="confirm-title">{pendingConfirm.title}</h2>
            <p id="confirm-body">{pendingConfirm.body}</p>
          </div>
          <footer className="modal-foot">
            <button id="confirm-cancel" className="btn" type="button" onClick={() => settle(false)}>
              Cancel
            </button>
            <button
              id="confirm-ok"
              className={`btn ${pendingConfirm.tone === "danger" ? "btn-danger" : "btn-primary"}`}
              type="button"
              onClick={() => settle(true)}
            >
              {pendingConfirm.confirmLabel}
            </button>
          </footer>
        </Modal>
      )}
    </FeedbackContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const tone = item.tone ?? "success";
  const { id } = item;
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(id), tone === "error" ? 10_000 : 3_500);
    return () => clearTimeout(timer);
  }, [onDismiss, id, tone]);
  return (
    <div className={`toast toast-${tone}`}>
      <Icon name={tone === "error" ? "alert" : "check"} />
      <p>{item.message}</p>
      {item.action && (
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => {
            onDismiss(id);
            item.action?.run();
          }}
        >
          {item.action.label}
        </button>
      )}
      <button
        className="btn btn-icon btn-sm btn-ghost"
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(id)}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}
