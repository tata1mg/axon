import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, isRequestError } from "../api.ts";
import { useHub } from "../hub-context.ts";
import { useFeedback } from "../ui/feedback.tsx";
import { Icon } from "../ui/Icon.tsx";
import { StatePanel } from "../ui/StatePanel.tsx";
import {
  LOCATION_LABELS,
  type LocalSkill,
  needsAttention,
  type SkillFilter,
  type SkillsView,
  skillTag,
  visibleSkills,
} from "./model.ts";
import "../mcp/mcp.css";
import "./skills.css";

function PageHead({ children }: { children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>Skills</h1>
        <p className="lede">
          Instructions Pi loads when a task calls for them, from your user-level skill folders.
          Changes apply after <code>/reload</code> in a running Pi session.
        </p>
      </div>
      {children}
    </div>
  );
}

function SkeletonList() {
  return (
    <ul className="server-list" aria-busy="true" aria-label="Loading skills">
      {[1, 2, 3].map((key) => (
        <li key={key} className="server skeleton" aria-hidden="true">
          <span className="skeleton-icon" />
          <span className="skeleton-line" />
        </li>
      ))}
    </ul>
  );
}

function SkillRow({ skill, onCopy }: { skill: LocalSkill; onCopy?: () => void }) {
  const tag = skillTag(skill);
  return (
    <li className="server" data-state={skill.status}>
      <span className="server-icon">
        <Icon name={skill.status === "not_loaded" ? "alert" : "book"} />
      </span>
      <div className="server-main">
        <div className="server-head">
          <h2 className="server-name">{skill.name}</h2>
          <span className="tag">{LOCATION_LABELS[skill.location]}</span>
          {!skill.modelInvocation && (
            <span className="tag tag-muted" title="disable-model-invocation is set">
              Only via /skill:{skill.name}
            </span>
          )}
          {tag && <span className={`tag tag-${tag.tone}`}>{tag.label}</span>}
        </div>
        <p className={skill.description ? "server-desc" : "server-desc placeholder"}>
          {skill.description || "No description"}
        </p>
        <code className="server-target">{skill.path}</code>
        {skill.problems.length > 0 && (
          <ul className="skill-problems">
            {skill.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="server-actions">
        {onCopy && (
          <button
            className="btn btn-icon btn-ghost btn-sm"
            type="button"
            aria-label={`Copy the path of ${skill.name}`}
            title="Copy path"
            onClick={onCopy}
          >
            <Icon name="copy" />
          </button>
        )}
      </div>
    </li>
  );
}

/** Read-only: lists what Pi loads from the user-level skill folders, including broken entries. */
export function SkillsPage() {
  const { endSession } = useHub();
  const { toast } = useFeedback();
  const [view, setView] = useState<SkillsView>();
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<SkillFilter>("all");
  const inFlight = useRef(false);
  const latest = useRef(view);
  latest.current = view;

  const load = useCallback(
    async (announce = false) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setLoading(true);
      try {
        setView(await api<SkillsView>("/skills"));
        setLoadError(undefined);
        if (announce) toast("Reloaded from disk");
      } catch (error) {
        if (isRequestError(error) && error.status === 401) endSession();
        else if (!latest.current) setLoadError(errorMessage(error));
        else if (announce) toast(errorMessage(error), { tone: "error" });
      } finally {
        inFlight.current = false;
        setLoading(false);
      }
    },
    [endSession, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Pick up skills added or edited while this tab was in the background.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && latest.current) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      toast("Path copied");
    } catch {
      toast("Couldn’t copy. Select the path and copy it manually.", { tone: "error" });
    }
  }

  const skills = view?.skills ?? [];
  const attention = skills.filter(needsAttention).length;
  const activeFilter = attention === 0 ? "all" : filter;
  const visible = visibleSkills(skills, activeFilter);
  const canCopy = "clipboard" in navigator;
  const primary = view?.locations.find(({ id }) => id === "axon")?.path;

  const refresh = (
    <button
      className={loading ? "btn btn-icon is-pending" : "btn btn-icon"}
      type="button"
      aria-label="Reload from disk"
      title="Reload from disk"
      disabled={!view && !loadError}
      onClick={() => void load(true)}
    >
      <Icon name="refresh" />
    </button>
  );

  let body: ReactNode;
  if (loadError)
    body = (
      <StatePanel icon="alert" tone="danger" title="Couldn’t read your skills" message={loadError}>
        <button className="btn" type="button" onClick={() => void load()}>
          Try again
        </button>
      </StatePanel>
    );
  else if (!view) body = <SkeletonList />;
  else if (skills.length === 0)
    body = (
      <StatePanel
        icon="book"
        title="No skills yet"
        message="A skill is a folder with a SKILL.md file that has a name and description in its frontmatter."
        {...(primary ? { hint: `Add one to \`${primary}\`, then run \`/reload\` in Pi.` } : {})}
      />
    );
  else
    body = (
      <section aria-label="Installed skills">
        {attention > 0 && (
          <div className="toolbar">
            <fieldset className="filters">
              <legend className="sr-only">Show</legend>
              <button
                className="filter"
                type="button"
                aria-pressed={activeFilter === "all"}
                onClick={() => setFilter("all")}
              >
                All <span className="count">{skills.length}</span>
              </button>
              <button
                className="filter filter-warn"
                type="button"
                aria-pressed={activeFilter === "attention"}
                onClick={() => setFilter("attention")}
              >
                Needs attention <span className="count">{attention}</span>
              </button>
            </fieldset>
          </div>
        )}
        <ul
          className={attention > 0 ? "server-list" : "server-list skills-list-spaced"}
          aria-label="Skills"
          aria-busy={loading}
        >
          {visible.map((skill) => (
            <SkillRow
              key={skill.path}
              skill={skill}
              {...(canCopy ? { onCopy: () => void copyPath(skill.path) } : {})}
            />
          ))}
        </ul>
      </section>
    );

  return (
    <>
      <PageHead>{refresh}</PageHead>
      {body}
      <footer className="page-foot">
        {view?.locations.map((location) => (
          <div key={location.id} className="config-path">
            <span className="foot-label">{LOCATION_LABELS[location.id]}</span>
            <code>{location.path}</code>
            <span>{location.exists ? "" : "Not created yet"}</span>
          </div>
        ))}
        {view?.truncated && (
          <p>Some folders were too large or too deep to scan, so this list may be incomplete.</p>
        )}
        <p>
          Pi loads the first skill with each name, in the order above. Project skills in{" "}
          <code>.pi/skills</code> or <code>.agents/skills</code>, and skills from Pi packages,
          aren’t shown.
        </p>
      </footer>
    </>
  );
}
