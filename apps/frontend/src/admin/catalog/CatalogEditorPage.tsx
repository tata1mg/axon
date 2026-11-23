import { ArrowLeft, FileUp, History, LoaderCircle, Save, Upload } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

import { useAdminAuth, useAdminSession } from "../auth-context";
import { AppLink, EmptyState, ErrorState, LoadingState, Panel } from "../components";
import { formatDateTime } from "../format";
import { roleIncludes } from "../types";
import { useAdminQuery } from "../use-admin-query";
import { catalogApi, type ItemAction, type ItemUpdate } from "./api";
import {
  AfterInstallSection,
  DetailsSection,
  InputsSection,
  JsonEditor,
  PrerequisitesSection,
  ServerSection,
  SkillSourceSection,
  StepsSection,
  type SectionProps,
} from "./EditorSections";
import { IssueList, ProblemCounts, StatusBadges, TierBadge } from "./fields";
import { ImportDialog } from "./ImportDialog";
import { KIND_LABELS, localIssues, newDraft, sameJson, slugify, SLUG_PATTERN, text } from "./model";
import { CatalogPreview } from "./Preview";
import type { CatalogItem, CatalogKind, Draft, RevisionSummary, ValidationResult } from "./types";

const LIST_PATH = "/admin/catalog";

function BackLink() {
  return (
    <AppLink
      to={LIST_PATH}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
    >
      <ArrowLeft aria-hidden className="size-4" />
      Catalog
    </AppLink>
  );
}

/** Existing item: load it, then edit. A reload after a conflict remounts the workspace. */
export function CatalogItemPage({ id }: { id: string }) {
  const item = useAdminQuery<CatalogItem>(`/catalog/items/${id}`);
  if (item.data)
    return (
      <Workspace
        key={`${item.data.id}:${item.data.lock_version}`}
        kind={item.data.kind}
        initial={item.data}
        onReload={item.reload}
      />
    );
  return (
    <div className="space-y-6">
      <BackLink />
      <Panel>
        {item.loading ? (
          <LoadingState />
        ) : (
          <ErrorState message={item.error ?? "Could not load this item."} onRetry={item.reload} />
        )}
      </Panel>
    </div>
  );
}

export function CatalogCreatePage({ kind }: { kind: CatalogKind }) {
  return <Workspace kind={kind} />;
}

/** Live validation while an admin edits. Viewers see the stored result instead. */
function useValidation(
  kind: CatalogKind,
  draft: Draft,
  enabled: boolean,
): { result: ValidationResult | undefined; checking: boolean } {
  const { handleApiError } = useAdminAuth();
  const [state, setState] = useState<{ draft: Draft; result: ValidationResult }>();
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      const local = localIssues(draft);
      if (local.length > 0) {
        setState({ draft, result: { valid: false, tier: null, errors: local, warnings: [] } });
        return;
      }
      catalogApi.validate(kind, draft).then(
        (result) => setState({ draft, result }),
        (failure: unknown) => {
          handleApiError(failure);
        },
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [kind, draft, enabled, handleApiError]);
  return { result: state?.result, checking: enabled && state?.draft !== draft };
}

type Confirm = "unpublish" | "archive" | "delete" | { restore: number } | null;

interface Notice {
  tone: "error" | "success";
  text: string;
  conflict?: boolean;
}

function Workspace({
  kind,
  initial,
  onReload,
}: {
  kind: CatalogKind;
  initial?: CatalogItem;
  onReload?: () => void;
}) {
  const { handleApiError } = useAdminAuth();
  const { user } = useAdminSession();
  const isAdmin = roleIncludes(user.role, "admin");

  const [item, setItem] = useState(initial);
  const [draft, setDraftState] = useState<Draft>(() => initial?.draft ?? newDraft(kind));
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(initial));
  const [featured, setFeatured] = useState(initial?.featured ?? false);
  const [sortOrder, setSortOrder] = useState(String(initial?.sort_order ?? 0));
  const [formKey, setFormKey] = useState(0);
  const [tab, setTab] = useState("form");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>();
  const [importing, setImporting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const archived = item?.status === "archived";
  const editable = isAdmin && !archived;
  const validation = useValidation(kind, draft, editable);
  const problems =
    validation.result ??
    (item && {
      valid: item.error_count === 0,
      tier: item.tier,
      errors: item.errors,
      warnings: item.warnings,
    });
  const order = Number(sortOrder);
  const orderValid = sortOrder.trim() !== "" && Number.isInteger(order) && Math.abs(order) <= 10000;
  const dirty =
    !item ||
    !sameJson(draft, item.draft) ||
    slug !== item.slug ||
    featured !== item.featured ||
    order !== item.sort_order;
  const listingValid = SLUG_PATTERN.test(slug) && orderValid;
  const named = text(draft.metadata.name).trim() !== "";

  const setDraft = useCallback((next: Draft, remount = false) => {
    setDraftState(next);
    if (remount) setFormKey((key) => key + 1);
  }, []);

  // Warn before leaving the page with unsaved edits.
  useEffect(() => {
    if (!dirty || !editable) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, editable]);

  function accept(next: CatalogItem, { replaceDraft = false } = {}) {
    setItem(next);
    if (replaceDraft) {
      setDraftState(next.draft);
      setSlug(next.slug);
      setFeatured(next.featured);
      setSortOrder(String(next.sort_order));
      setFormKey((key) => key + 1);
    }
  }

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label);
    setNotice(undefined);
    try {
      await task();
    } catch (failure) {
      const conflict = failure instanceof ApiError && failure.status === 409 && Boolean(item);
      setNotice({ tone: "error", text: handleApiError(failure), conflict });
    } finally {
      setBusy(null);
    }
  }

  async function saveChanges(): Promise<CatalogItem> {
    if (!item) throw new Error("Create the item first");
    const body: ItemUpdate = { lock_version: item.lock_version };
    if (!sameJson(draft, item.draft)) body.draft = draft;
    if (slug !== item.slug) body.slug = slug;
    if (featured !== item.featured) body.featured = featured;
    if (order !== item.sort_order) body.sort_order = order;
    const saved = await catalogApi.update(item.id, body);
    accept(saved);
    return saved;
  }

  function save() {
    void run("save", async () => {
      if (!item) {
        const created = await catalogApi.create({ kind, slug, draft, featured, sort_order: order });
        navigate(`${LIST_PATH}/${created.id}`, { replace: true });
        return;
      }
      await saveChanges();
      setNotice({
        tone: "success",
        text: "Draft saved. Publish it when it's ready for developers.",
      });
    });
  }

  function publish(note: string) {
    setPublishing(false);
    void run("publish", async () => {
      const current = dirty ? await saveChanges() : item;
      if (!current) return;
      const published = await catalogApi.act(
        current.id,
        "publish",
        current.lock_version,
        note.trim() || undefined,
      );
      accept(published, { replaceDraft: true });
      setNotice({ tone: "success", text: `Published revision ${published.published_revision}.` });
    });
  }

  function changeStatus(action: Exclude<ItemAction, "publish">) {
    setConfirm(null);
    void run(action, async () => {
      if (!item) return;
      const updated = await catalogApi.act(item.id, action, item.lock_version);
      accept(updated, { replaceDraft: true });
      const done = {
        unpublish: "Unpublished.",
        archive: "Archived.",
        unarchive: "Restored to draft.",
      };
      setNotice({ tone: "success", text: done[action] });
    });
  }

  function remove() {
    setConfirm(null);
    void run("delete", async () => {
      if (!item) return;
      await catalogApi.remove(item.id, item.lock_version);
      navigate(LIST_PATH);
    });
  }

  function restore(revision: number) {
    setConfirm(null);
    void run("restore", async () => {
      if (!item) return;
      const restored = await catalogApi.restore(item.id, revision, item.lock_version);
      accept(restored, { replaceDraft: true });
      setTab("form");
      setNotice({
        tone: "success",
        text: `Revision ${revision} copied into the draft. Publish to make it current.`,
      });
    });
  }

  const sectionProps: SectionProps = {
    draft,
    onDraft: setDraft,
    disabled: !editable,
    errors: problems?.errors ?? [],
    warnings: problems?.warnings ?? [],
  };
  const errorCount = problems?.errors.length ?? 0;
  const canPublish =
    editable &&
    Boolean(item) &&
    named &&
    listingValid &&
    errorCount === 0 &&
    !validation.checking &&
    (dirty || item?.status !== "published" || item.has_unpublished_changes);
  const title = text(draft.metadata.name).trim() || `New ${KIND_LABELS[kind].one}`;

  return (
    <div className="space-y-6">
      <BackLink />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight break-words">
            {title}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {item ? (
              <StatusBadges item={item} />
            ) : (
              <span className="text-muted-foreground">Not saved yet</span>
            )}
            {item && dirty && editable && <Badge variant="secondary">Unsaved changes</Badge>}
            {kind === "mcp" && <TierBadge tier={problems?.tier ?? null} />}
            <ProblemCounts errors={errorCount} warnings={problems?.warnings.length ?? 0} />
            {validation.checking && (
              <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                <LoaderCircle aria-hidden className="size-3 animate-spin" />
                Checking…
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {archived && isAdmin && (
            <Button size="lg" disabled={busy !== null} onClick={() => changeStatus("unarchive")}>
              Unarchive
            </Button>
          )}
          {editable && kind === "mcp" && (
            <Button
              variant="outline"
              size="lg"
              disabled={busy !== null}
              onClick={() => setImporting(true)}
            >
              <FileUp aria-hidden data-icon="inline-start" />
              Import from mcp.json
            </Button>
          )}
          {editable && (
            <Button
              variant={item ? "outline" : "default"}
              size="lg"
              disabled={busy !== null || !dirty || !named || !listingValid}
              onClick={save}
            >
              <Save aria-hidden data-icon="inline-start" />
              {item ? "Save draft" : "Create draft"}
            </Button>
          )}
          {editable && item && (
            <Button
              size="lg"
              disabled={busy !== null || !canPublish}
              onClick={() => setPublishing(true)}
            >
              <Upload aria-hidden data-icon="inline-start" />
              {dirty ? "Save and publish" : "Publish"}
            </Button>
          )}
        </div>
      </header>

      {editable && !named && (
        <p className="text-muted-foreground text-sm">Add a name to save this draft.</p>
      )}
      {editable && named && !SLUG_PATTERN.test(slug) && (
        <p className="text-muted-foreground text-sm">
          The slug needs 2–63 lowercase letters, digits or hyphens, starting with a letter or digit.
        </p>
      )}
      {editable && !orderValid && (
        <p className="text-muted-foreground text-sm">
          Sort order must be a whole number between -10000 and 10000.
        </p>
      )}

      {notice && (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={cn(
            "flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm",
            notice.tone === "error" ? "border-destructive/40 bg-destructive/5" : "bg-muted/40",
          )}
        >
          <span className="flex-1">{notice.text}</span>
          {notice.conflict && onReload && (
            <Button variant="outline" size="sm" onClick={onReload}>
              Reload (discards your edits)
            </Button>
          )}
        </div>
      )}
      {archived && (
        <p className="bg-muted/40 rounded-lg border px-4 py-3 text-sm">
          This item is archived and hidden from developers. Unarchive it to edit or publish it
          again.
        </p>
      )}
      {!isAdmin && (
        <p className="bg-muted/40 rounded-lg border px-4 py-3 text-sm">
          You can view this entry. Only admins can change it.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="form">Form</TabsTrigger>
              <TabsTrigger value="json">JSON</TabsTrigger>
            </TabsList>
            <TabsContent value="form" className="mt-4 space-y-6">
              <div key={formKey} className="space-y-6">
                <DetailsSection
                  {...sectionProps}
                  listing={{
                    slug,
                    slugLocked: item !== undefined && item.latest_revision !== null,
                    featured,
                    sortOrder,
                    onSlug: (value) => {
                      setSlug(value);
                      setSlugTouched(true);
                    },
                    onFeatured: setFeatured,
                    onSortOrder: setSortOrder,
                    onName: slugTouched ? undefined : (name) => setSlug(slugify(name)),
                  }}
                />
                {kind === "mcp" ? (
                  <>
                    <ServerSection {...sectionProps} />
                    <InputsSection {...sectionProps} />
                    <PrerequisitesSection {...sectionProps} />
                    <StepsSection {...sectionProps} />
                    <AfterInstallSection {...sectionProps} />
                  </>
                ) : (
                  <SkillSourceSection {...sectionProps} />
                )}
              </div>
            </TabsContent>
            <TabsContent value="json" className="mt-4">
              <JsonEditor
                key={formKey}
                draft={draft}
                disabled={!editable}
                onApply={(next) => {
                  setDraft(next, true);
                  setTab("form");
                }}
              />
            </TabsContent>
          </Tabs>

          {item && (
            <HistoryPanel
              item={item}
              canRestore={editable}
              onRestore={(revision) =>
                dirty ? setConfirm({ restore: revision }) : restore(revision)
              }
            />
          )}
          {item && isAdmin && !archived && (
            <ManagePanel
              item={item}
              busy={busy !== null}
              onUnpublish={() => setConfirm("unpublish")}
              onArchive={() => setConfirm("archive")}
              onDelete={() => setConfirm("delete")}
            />
          )}
        </div>

        <aside className="min-w-0 space-y-6 self-start lg:sticky lg:top-6">
          <Panel title="Problems">
            <div className="space-y-3 p-4">
              {!problems ? (
                <p className="text-muted-foreground text-xs">Checking the draft…</p>
              ) : problems.errors.length === 0 && problems.warnings.length === 0 ? (
                <p className="text-muted-foreground text-xs">No problems found.</p>
              ) : (
                <>
                  <IssueList issues={problems.errors} tone="error" />
                  <IssueList issues={problems.warnings} tone="warning" />
                  {problems.warnings.length > 0 && (
                    <p className="text-muted-foreground text-xs">
                      Warnings are suggestions. They don&apos;t block publishing.
                    </p>
                  )}
                </>
              )}
            </div>
          </Panel>
          <Panel title="Preview">
            <div className="p-4">
              <CatalogPreview kind={kind} draft={draft} tier={problems?.tier ?? null} />
            </div>
          </Panel>
        </aside>
      </div>

      {kind === "mcp" && (
        <ImportDialog
          open={importing}
          onOpenChange={setImporting}
          current={draft}
          onApply={(next, importedSlug) => {
            setDraft(next, true);
            if (!item && importedSlug && !slugTouched) setSlug(importedSlug);
            setNotice({ tone: "success", text: "Imported. Review the form, then save." });
          }}
        />
      )}
      <PublishDialog
        open={publishing}
        nextRevision={(item?.latest_revision ?? 0) + 1}
        warnings={problems?.warnings.length ?? 0}
        savesFirst={dirty}
        onCancel={() => setPublishing(false)}
        onPublish={publish}
      />
      <ConfirmDialog
        confirm={confirm}
        dirty={dirty}
        onCancel={() => setConfirm(null)}
        onConfirm={(choice) => {
          if (choice === "delete") remove();
          else if (choice === "unpublish" || choice === "archive") changeStatus(choice);
          else if (choice) restore(choice.restore);
        }}
      />
    </div>
  );
}

function PublishDialog({
  open,
  nextRevision,
  warnings,
  savesFirst,
  onCancel,
  onPublish,
}: {
  open: boolean;
  nextRevision: number;
  warnings: number;
  savesFirst: boolean;
  onCancel: () => void;
  onPublish: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish revision {nextRevision}</DialogTitle>
          <DialogDescription>
            {savesFirst ? "Your unsaved changes are saved first. " : ""}
            Developers get this revision in <code>axon hub</code>, and those who installed an older
            one see an update.
          </DialogDescription>
        </DialogHeader>
        {warnings > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {warnings === 1
              ? "1 warning remains. It doesn't"
              : `${warnings} warnings remain. They don't`}{" "}
            block publishing.
          </p>
        )}
        <div className="space-y-1.5">
          <label htmlFor="publish-note" className="text-xs font-medium">
            What changed? (optional)
          </label>
          <Textarea
            id="publish-note"
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="lg" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="lg"
            onClick={() => {
              onPublish(note);
              setNote("");
            }}
          >
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CONFIRM_COPY: Record<
  "unpublish" | "archive" | "delete",
  { title: string; body: string; action: string }
> = {
  unpublish: {
    title: "Unpublish this item?",
    body: "It disappears from axon hub. Copies developers already installed stay on their machines. You can publish it again later.",
    action: "Unpublish",
  },
  archive: {
    title: "Archive this item?",
    body: "It disappears from axon hub and from this list. Installed copies stay on developers' machines. You can unarchive it later.",
    action: "Archive",
  },
  delete: {
    title: "Delete this draft?",
    body: "This permanently deletes the draft. It was never published, so no developer has it.",
    action: "Delete",
  },
};

function ConfirmDialog({
  confirm,
  dirty,
  onCancel,
  onConfirm,
}: {
  confirm: Confirm;
  dirty: boolean;
  onCancel: () => void;
  onConfirm: (choice: Confirm) => void;
}) {
  const copy =
    confirm === null
      ? null
      : typeof confirm === "object"
        ? {
            title: `Restore revision ${confirm.restore}?`,
            body: "Its content replaces the draft. You have unsaved changes; they will be lost.",
            action: "Discard and restore",
          }
        : CONFIRM_COPY[confirm];
  const destructive = confirm === "delete" || confirm === "archive" || typeof confirm === "object";
  return (
    <Dialog open={copy !== null} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        {copy && (
          <>
            <DialogHeader>
              <DialogTitle>{copy.title}</DialogTitle>
              <DialogDescription>
                {copy.body}
                {dirty && typeof confirm === "string" && confirm !== "delete"
                  ? " Unsaved changes in the form are discarded."
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" size="lg" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                variant={destructive ? "destructive" : "default"}
                size="lg"
                onClick={() => onConfirm(confirm)}
              >
                {copy.action}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ManagePanel({
  item,
  busy,
  onUnpublish,
  onArchive,
  onDelete,
}: {
  item: CatalogItem;
  busy: boolean;
  onUnpublish: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const rows: { label: string; detail: string; action: ReactNode }[] = [];
  if (item.status === "published")
    rows.push({
      label: "Unpublish",
      detail: "Hide it from axon hub. Installed copies stay on developers' machines.",
      action: (
        <Button variant="outline" size="lg" disabled={busy} onClick={onUnpublish}>
          Unpublish
        </Button>
      ),
    });
  if (item.latest_revision === null)
    rows.push({
      label: "Delete",
      detail: "Permanently delete this draft. It was never published.",
      action: (
        <Button variant="destructive" size="lg" disabled={busy} onClick={onDelete}>
          Delete
        </Button>
      ),
    });
  else
    rows.push({
      label: "Archive",
      detail: "Hide it from axon hub and this list. Published items keep their history.",
      action: (
        <Button variant="destructive" size="lg" disabled={busy} onClick={onArchive}>
          Archive
        </Button>
      ),
    });
  return (
    <Panel title="Manage">
      <ul className="divide-y">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0 text-sm">
              <p className="font-medium">{row.label}</p>
              <p className="text-muted-foreground text-xs">{row.detail}</p>
            </div>
            {row.action}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function HistoryPanel({
  item,
  canRestore,
  onRestore,
}: {
  item: CatalogItem;
  canRestore: boolean;
  onRestore: (revision: number) => void;
}) {
  const { handleApiError } = useAdminAuth();
  const [revisions, setRevisions] = useState<RevisionSummary[]>();
  const [error, setError] = useState<string>();
  const [viewing, setViewing] = useState<{
    revision: number;
    content?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    catalogApi.revisions(item.id).then(
      (result) => {
        if (cancelled) return;
        setRevisions(result);
        setError(undefined);
      },
      (failure: unknown) => {
        if (!cancelled) setError(handleApiError(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [item.id, item.latest_revision, item.published_revision, handleApiError]);

  function view(revision: number) {
    setViewing({ revision });
    catalogApi.revision(item.id, revision).then(
      (result) => setViewing({ revision, content: JSON.stringify(result.content, null, 2) }),
      (failure: unknown) => setViewing({ revision, error: handleApiError(failure) }),
    );
  }

  return (
    <Panel title="History">
      {error ? (
        <ErrorState message={error} />
      ) : !revisions ? (
        <LoadingState />
      ) : revisions.length === 0 ? (
        <EmptyState>Not published yet. Each publish adds a revision here.</EmptyState>
      ) : (
        <ul className="divide-y">
          {revisions.map((revision) => (
            <li
              key={revision.revision}
              className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
            >
              <History aria-hidden className="text-muted-foreground size-4" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  Revision {revision.revision}
                  {revision.current && (
                    <span className="text-muted-foreground font-normal"> · live</span>
                  )}
                </p>
                <p className="text-muted-foreground text-xs break-all">
                  {formatDateTime(revision.published_at)} by {revision.published_by_email}
                  {revision.note ? ` · ${revision.note}` : ""}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => view(revision.revision)}>
                View
              </Button>
              {canRestore && (
                <Button variant="outline" size="sm" onClick={() => onRestore(revision.revision)}>
                  Restore to draft
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={viewing !== null} onOpenChange={(next) => !next && setViewing(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Revision {viewing?.revision}</DialogTitle>
            <DialogDescription>
              The exact content developers receive for this revision.
            </DialogDescription>
          </DialogHeader>
          {viewing?.error ? (
            <p className="text-destructive text-sm">{viewing.error}</p>
          ) : viewing?.content ? (
            <pre className="bg-muted max-h-[60svh] overflow-auto rounded-md p-3 font-mono text-xs">
              {viewing.content}
            </pre>
          ) : (
            <LoadingState />
          )}
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
