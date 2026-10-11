import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { CircleAlert } from "lucide-react";
import { issuesApi } from "../../api/issues";
import { reportedProblemsApi } from "../../api/reportedProblems";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "../../lib/utils";

interface ReportProblemDialogProps {
  issue: Issue;
  companyId?: string;
}

export function ReportProblemDialog({ issue, companyId }: ReportProblemDialogProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedCommentIds, setSelectedCommentIds] = useState<string[]>([]);
  const queryClient = useQueryClient();

  const { data: comments } = useQuery({
    queryKey: ["issues", issue.id, "comments", "report-problem"] as const,
    queryFn: () => issuesApi.listComments(issue.id, { order: "desc", limit: 100 }),
    enabled: open,
  });

  const submit = useMutation({
    mutationFn: () =>
      reportedProblemsApi.create(companyId ?? issue.companyId, {
        title,
        description,
        sourceIssueId: issue.id,
        commentIds: selectedCommentIds,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reported-problems"] });
      setOpen(false);
      setTitle("");
      setDescription("");
      setSelectedCommentIds([]);
    },
  });

  const toggleComment = (id: string) => {
    setSelectedCommentIds((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <CircleAlert className="size-3.5" aria-hidden />
          Report a Paperclip problem
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report a Paperclip problem</DialogTitle>
          <DialogDescription>
            File a backlog issue for the fixer and link it to the current AGENTS.md version.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="report-problem-title">Title</Label>
            <Textarea
              id="report-problem-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What went wrong?"
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="report-problem-description">Description</Label>
            <Textarea
              id="report-problem-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Add any detail that helps the fixer reproduce it."
              rows={4}
            />
          </div>

          {(comments ?? []).length > 0 ? (
            <div className="space-y-1.5">
              <Label>Attach comments</Label>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {(comments ?? []).map((comment) => (
                  <label
                    key={comment.id}
                    className="flex items-start gap-2 rounded-sm p-1.5 hover:bg-accent/50"
                  >
                    <Checkbox
                      checked={selectedCommentIds.includes(comment.id)}
                      onCheckedChange={() => toggleComment(comment.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-xs text-muted-foreground">{comment.body}</span>
                      <span className="mt-0.5 block text-(length:--text-nano) text-muted-foreground">
                        {formatDate(comment.createdAt)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={submit.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => submit.mutate()}
            disabled={submit.isPending || title.trim().length === 0}
          >
            {submit.isPending ? "Filing…" : "File problem"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
