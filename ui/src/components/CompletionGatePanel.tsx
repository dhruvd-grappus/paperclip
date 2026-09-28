import {
  DEFAULT_COMPLETION_EVIDENCE_POLICY,
  type CompletionEvidencePolicy,
  type CompletionEvidenceRequirement,
  type CompletionEvidenceScope,
} from "@paperclipai/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleField } from "./agent-config-primitives";

type ScopeOption = { value: CompletionEvidenceScope; label: string; effect: string };
type RequirementOption = { value: CompletionEvidenceRequirement; label: string; effect: string };
type DescendantOption = { value: "yes" | "no"; label: string; effect: string };

const SCOPE_OPTIONS: ScopeOption[] = [
  {
    value: "all",
    label: "Every task",
    effect: "No task can be completed without evidence.",
  },
  {
    value: "parents",
    label: "Tasks with subtasks",
    effect: "Only umbrella tasks are checked. A leaf task completes as it does today.",
  },
  {
    value: "roots",
    label: "Top-level tasks",
    effect: "Only tasks with no parent are checked. Subtasks complete as they do today.",
  },
];

const REQUIREMENT_OPTIONS: RequirementOption[] = [
  {
    value: "either",
    label: "A pull request or an artifact",
    effect: "One is enough. A docs change with only a PR, or research with only a report, still completes.",
  },
  {
    value: "both",
    label: "A pull request and an artifact",
    effect: "Both must be present. Strict: work that legitimately produces only one kind cannot be completed.",
  },
];

const DESCENDANT_OPTIONS: DescendantOption[] = [
  {
    value: "yes",
    label: "Count evidence on subtasks",
    effect: "A parent is credited with what its subtasks recorded. Usually what you want — an umbrella task owns no PR of its own.",
  },
  {
    value: "no",
    label: "Own evidence only",
    effect: "A task must carry its own evidence. A parent whose children did the work will not pass.",
  },
];

function PolicySelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  testId,
  ariaLabel,
  label,
}: {
  value: T;
  options: { value: T; label: string; effect: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  testId: string;
  ariaLabel: string;
  label: string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <div className="min-w-0">
      <span className="mb-1 block text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
        <SelectTrigger
          size="sm"
          aria-label={ariaLabel}
          className="w-full min-w-0 text-xs sm:w-(--sz-280px)"
          data-testid={testId}
        >
          {/*
           * Explicit children rather than a bare `<SelectValue />`: Radix
           * portals the selected item's whole subtree into the trigger, which
           * would drag each option's effect sentence into the closed control.
           */}
          <SelectValue>{selected?.label ?? value}</SelectValue>
        </SelectTrigger>
        <SelectContent className="max-w-(--sz-280px) sm:max-w-(--sz-360px)">
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              textValue={option.label}
              className="text-xs"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{option.label}</span>
                <span className="text-(length:--text-micro) text-muted-foreground">
                  {option.effect}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Company-level completion gate: what a task must show before it can be done.
 *
 * The gate ships off, and the panel says so rather than presenting an inert
 * switch as if it were already protecting anything. The three selects stay
 * visible while it is off so an administrator can see the exact rule they are
 * about to turn on — a gate whose terms are hidden until it is live is one you
 * discover by having the board wedge.
 */
export function CompletionGatePanel({
  policy,
  onChange,
  isPending,
  errorMessage,
}: {
  policy: CompletionEvidencePolicy;
  onChange: (next: CompletionEvidencePolicy) => void;
  isPending?: boolean;
  errorMessage?: string | null;
}) {
  const effective = policy ?? DEFAULT_COMPLETION_EVIDENCE_POLICY;
  return (
    <div className="max-w-2xl space-y-4" data-testid="company-settings-completion-gate-section">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Completion evidence
      </div>
      <p className="text-sm text-muted-foreground">
        When this is on, a task cannot move to{" "}
        <span className="font-medium text-foreground">Done</span> until it has recorded
        proof of what it produced: a{" "}
        <span className="font-medium text-foreground">pull request</span> work product, or
        an <span className="font-medium text-foreground">artifact</span> — an upload, a
        published preview, or a running service. A branch or a commit does not count;
        pushing code is not evidence anyone checked it.{" "}
        <span className="font-medium text-foreground">Human approved</span> is a separate
        step a person applies to an already-done task, and is never available to an agent.
      </p>
      <ToggleField
        label="Require completion evidence"
        hint="Off by default. Turn this on only once agents reliably record their work products, or in-flight tasks will not be able to complete."
        checked={effective.enabled}
        onChange={(enabled) => onChange({ ...effective, enabled })}
        toggleTestId="completion-gate-enabled-toggle"
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PolicySelect
          label="Applies to"
          ariaLabel="Which tasks the completion gate applies to"
          testId="completion-gate-scope"
          value={effective.scope}
          options={SCOPE_OPTIONS}
          disabled={isPending}
          onChange={(scope) => onChange({ ...effective, scope })}
        />
        <PolicySelect
          label="Requires"
          ariaLabel="What evidence a task must show"
          testId="completion-gate-require"
          value={effective.require}
          options={REQUIREMENT_OPTIONS}
          disabled={isPending}
          onChange={(require) => onChange({ ...effective, require })}
        />
        <PolicySelect
          label="Subtask evidence"
          ariaLabel="Whether evidence on subtasks counts for a parent task"
          testId="completion-gate-count-descendants"
          value={effective.countDescendants ? "yes" : "no"}
          options={DESCENDANT_OPTIONS}
          disabled={isPending}
          onChange={(value) => onChange({ ...effective, countDescendants: value === "yes" })}
        />
      </div>
      {!effective.enabled && (
        <p className="text-xs text-muted-foreground" data-testid="completion-gate-inactive-note">
          The gate is off. These settings are saved but nothing is blocked.
        </p>
      )}
      {errorMessage && (
        <p className="text-xs text-destructive" data-testid="completion-gate-error">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
