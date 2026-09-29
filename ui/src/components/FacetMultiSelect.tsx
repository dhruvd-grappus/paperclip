import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface FacetOption {
  /** The filter value sent to the server. */
  value: string;
  label: string;
  /** How many rows carry this value in the *unfiltered* list. */
  count?: number;
}

/**
 * A small tick-list filter over one facet, with counts.
 *
 * `MemberMultiSelect` and `AgentMultiSelect` are the system pickers for people
 * and agents, but both are keyed to a directory record — they render an
 * identity, and they cannot express the buckets a facet needs ("no owner",
 * "no project"), which are rows rather than records. This is the plain
 * value/label/count version for filtering a list by a facet the list itself
 * reported.
 *
 * Nothing ticked means no filter, which is why the trigger reads "Anyone" or
 * "All projects" rather than showing an empty selection: an empty tick-list is
 * how a person says they do not care about this axis.
 */
export function FacetMultiSelect({
  label,
  allLabel,
  options,
  selected,
  onChange,
  testId,
  className = "w-56",
}: {
  /** Names the axis in the trigger once more than one value is ticked. */
  label: string;
  /** Trigger text when nothing is ticked. */
  allLabel: string;
  options: readonly FacetOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  testId?: string;
  className?: string;
}) {
  const selectedSet = new Set(selected);
  const toggle = (value: string) => {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange([...next]);
  };

  // One tick names itself; several would not fit, so they are counted.
  const triggerText =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? options.find((option) => option.value === selected[0])?.label ?? allLabel
        : `${selected.length} ${label}`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={`${className} justify-between font-normal`}
          data-testid={testId}
        >
          <span className="truncate">{triggerText}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">Nothing to filter by.</p>
        ) : (
          <>
            <div className="max-h-72 overflow-y-auto">
              {options.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <Checkbox
                    checked={selectedSet.has(option.value)}
                    onCheckedChange={() => toggle(option.value)}
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.count != null ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{option.count}</span>
                  ) : null}
                </label>
              ))}
            </div>
            {selected.length > 0 ? (
              <button
                type="button"
                className="w-full rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent"
                onClick={() => onChange([])}
              >
                Clear
              </button>
            ) : null}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
