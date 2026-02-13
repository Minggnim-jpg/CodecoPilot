"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  XIcon,
  MinusIcon,
  LoaderIcon,
  CircleIcon,
  CopyIcon,
  DownloadIcon,
} from "lucide-react";

interface InstallProgress {
  status: "idle" | "running" | "success" | "failed" | "cancelled";
  currentStep: string | null;
  steps: Array<{
    id: string;
    label: string;
    status: "pending" | "running" | "success" | "failed" | "skipped";
    error?: string;
  }>;
  logs: string[];
}

interface InstallWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstallComplete?: () => void;
}

type WizardPhase =
  | "checking"
  | "confirm"
  | "already-installed"
  | "installing"
  | "success"
  | "failed";

interface PrereqResult {
  hasNode: boolean;
  nodeVersion?: string;
  hasClaude: boolean;
  claudeVersion?: string;
}

function getInstallAPI() {
  if (typeof window !== "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).electronAPI?.install as
      | {
          checkPrerequisites: () => Promise<PrereqResult>;
          start: (options?: { includeNode?: boolean }) => Promise<void>;
          cancel: () => Promise<void>;
          getLogs: () => Promise<string[]>;
          onProgress: (
            callback: (progress: InstallProgress) => void
          ) => () => void;
        }
      | undefined;
  }
  return undefined;
}

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case "success":
      return <CheckIcon className="size-4 text-emerald-500" />;
    case "running":
      return <LoaderIcon className="size-4 text-blue-500 animate-spin" />;
    case "failed":
      return <XIcon className="size-4 text-red-500" />;
    case "skipped":
      return <MinusIcon className="size-4 text-muted-foreground" />;
    default:
      return <CircleIcon className="size-3.5 text-muted-foreground/40" />;
  }
}

export function InstallWizard({
  open,
  onOpenChange,
  onInstallComplete,
}: InstallWizardProps) {
  const [phase, setPhase] = useState<WizardPhase>("checking");
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [prereqs, setPrereqs] = useState<PrereqResult | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const scrollToBottom = useCallback(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [logs, scrollToBottom]);

  // Cancel backend install and clean up listener
  const cancelInstall = useCallback(async () => {
    const api = getInstallAPI();
    if (!api) return;
    try {
      await api.cancel();
    } catch {
      // ignore cancel errors
    }
  }, []);

  const startInstall = useCallback(async (options?: { includeNode?: boolean }) => {
    const api = getInstallAPI();
    if (!api) return;

    setPhase("installing");

    // Subscribe to progress updates
    if (cleanupRef.current) cleanupRef.current();
    cleanupRef.current = api.onProgress((p) => {
      setProgress(p);
      setLogs(p.logs);

      if (p.status === "success") {
        setPhase("success");
      } else if (p.status === "failed" || p.status === "cancelled") {
        setPhase("failed");
      }
    });

    try {
      await api.start(options);
    } catch (err: unknown) {
      setPhase("failed");
      const msg = err instanceof Error ? err.message : String(err);
      setLogs((prev) => [...prev, `Installation error: ${msg}`]);
    }
  }, []);

  const checkPrereqs = useCallback(async () => {
    const api = getInstallAPI();
    if (!api) return;

    setPhase("checking");
    setLogs(["Checking environment..."]);
    setProgress(null);
    setPrereqs(null);

    try {
      const result = await api.checkPrerequisites();
      setPrereqs(result);

      if (result.hasClaude) {
        setLogs((prev) => [
          ...prev,
          `Node.js ${result.nodeVersion} found.`,
          `Claude Code ${result.claudeVersion} already installed.`,
        ]);
        setPhase("already-installed");
        return;
      }

      // Don't auto-install — show confirmation first
      if (result.hasNode) {
        setLogs((prev) => [
          ...prev,
          `Node.js ${result.nodeVersion} found.`,
          "Claude Code CLI not detected.",
        ]);
      } else {
        setLogs((prev) => [
          ...prev,
          "Node.js not found.",
          "Claude Code CLI not detected.",
        ]);
      }
      setPhase("confirm");
    } catch (err: unknown) {
      setPhase("failed");
      const msg = err instanceof Error ? err.message : String(err);
      setLogs((prev) => [...prev, `Error checking prerequisites: ${msg}`]);
    }
  }, []);

  // User explicitly clicks "Install" — only then start the actual install
  const handleConfirmInstall = useCallback(() => {
    const needsNode = prereqs ? !prereqs.hasNode : false;
    startInstall({ includeNode: needsNode });
  }, [prereqs, startInstall]);

  const handleCopyLogs = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(logs.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  }, [logs]);

  const handleDone = useCallback(() => {
    onOpenChange(false);
    onInstallComplete?.();
  }, [onOpenChange, onInstallComplete]);

  // [P1] Close dialog = cancel running install
  const handleOpenChange = useCallback(
    async (nextOpen: boolean) => {
      if (!nextOpen && phase === "installing") {
        await cancelInstall();
      }
      onOpenChange(nextOpen);
    },
    [phase, cancelInstall, onOpenChange]
  );

  // Auto-check when dialog opens
  useEffect(() => {
    if (open) {
      setPhase("checking"); // eslint-disable-line react-hooks/set-state-in-effect -- reset state before async check
      setLogs([]); // eslint-disable-line react-hooks/set-state-in-effect
      setProgress(null); // eslint-disable-line react-hooks/set-state-in-effect
      setCopied(false); // eslint-disable-line react-hooks/set-state-in-effect
      setPrereqs(null); // eslint-disable-line react-hooks/set-state-in-effect
      checkPrereqs();
    }
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [open, checkPrereqs]);

  const steps = progress?.steps ?? [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install Claude Code</DialogTitle>
          <DialogDescription>
            {phase === "confirm"
              ? "Claude Code CLI was not detected. Install it now?"
              : "Automatically install Claude Code CLI"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Step list (only during/after install) */}
          {steps.length > 0 && (
            <div className="space-y-2">
              {steps.map((step) => (
                <div
                  key={step.id}
                  className="flex items-center gap-2.5 text-sm"
                >
                  <StepIcon status={step.status} />
                  <span
                    className={cn(
                      step.status === "pending" && "text-muted-foreground",
                      step.status === "running" && "text-foreground font-medium",
                      step.status === "success" && "text-emerald-700 dark:text-emerald-400",
                      step.status === "failed" && "text-red-700 dark:text-red-400",
                      step.status === "skipped" && "text-muted-foreground"
                    )}
                  >
                    {step.label}
                  </span>
                  {step.error && (
                    <span className="text-xs text-red-500 ml-auto truncate max-w-[200px]">
                      {step.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Phase: checking */}
          {phase === "checking" && steps.length === 0 && (
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              <span>Checking environment...</span>
            </div>
          )}

          {/* Phase: confirm — ask user before installing */}
          {phase === "confirm" && (
            <div className="space-y-3">
              <div className="rounded-lg bg-amber-500/10 px-4 py-3 text-sm space-y-1.5">
                {prereqs && !prereqs.hasNode && (
                  <p className="text-amber-700 dark:text-amber-400">
                    Node.js — not found (will be installed via {process.platform === "win32" ? "winget" : "Homebrew"})
                  </p>
                )}
                {prereqs?.hasNode && (
                  <p className="text-emerald-700 dark:text-emerald-400">
                    Node.js {prereqs.nodeVersion} — found
                  </p>
                )}
                <p className="text-amber-700 dark:text-amber-400">
                  Claude Code CLI — not found
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                Click <strong>Install</strong> to automatically set up{" "}
                {prereqs && !prereqs.hasNode ? "Node.js and " : ""}Claude Code CLI.
              </p>
            </div>
          )}

          {/* Phase: already-installed */}
          {phase === "already-installed" && (
            <div className="flex items-center gap-3 rounded-lg bg-emerald-500/10 px-4 py-3">
              <CheckIcon className="size-5 text-emerald-500 shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-emerald-700 dark:text-emerald-400">
                  Already installed
                </p>
                <p className="text-muted-foreground text-xs">
                  Claude Code is already available.
                </p>
              </div>
            </div>
          )}

          {/* Phase: success */}
          {phase === "success" && (
            <div className="flex items-center gap-3 rounded-lg bg-emerald-500/10 px-4 py-3">
              <CheckIcon className="size-5 text-emerald-500 shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-emerald-700 dark:text-emerald-400">
                  Installation complete
                </p>
                <p className="text-muted-foreground text-xs">
                  Claude Code CLI has been installed successfully.
                </p>
              </div>
            </div>
          )}

          {/* Log output */}
          {logs.length > 0 && (
            <div className="rounded-md bg-zinc-950 dark:bg-zinc-900 border border-zinc-800 max-h-48 overflow-y-auto">
              <div className="p-3 font-mono text-xs text-zinc-300 space-y-0.5">
                {logs.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">
                    {line}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {logs.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyLogs}
            >
              <CopyIcon />
              {copied ? "Copied" : "Copy Logs"}
            </Button>
          )}

          {/* Confirm phase: single "Install" button */}
          {phase === "confirm" && (
            <Button size="sm" onClick={handleConfirmInstall}>
              <DownloadIcon />
              Install
            </Button>
          )}

          {/* Installing: cancel button */}
          {phase === "installing" && (
            <Button variant="destructive" size="sm" onClick={cancelInstall}>
              Cancel
            </Button>
          )}

          {/* Failed: retry */}
          {phase === "failed" && (
            <Button size="sm" onClick={checkPrereqs}>
              Retry
            </Button>
          )}

          {/* Success / already-installed: done */}
          {(phase === "success" || phase === "already-installed") && (
            <Button size="sm" onClick={handleDone}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
