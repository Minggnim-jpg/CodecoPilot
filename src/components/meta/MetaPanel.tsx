"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { SparklesIcon, XIcon } from "lucide-react";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePanel } from "@/hooks/usePanel";
import { consumeSSEStream } from "@/hooks/useSSEStream";
import { useMetaPanel } from "./MetaPanelContext";

const META_PANEL_WIDTH_KEY = "codepal_metapanel_width";
const META_PANEL_DEFAULT_WIDTH = 440;
const META_PANEL_MIN = 260;
const META_PANEL_MAX = 560;
const MAIN_CONTENT_MIN_WIDTH = 480;

interface MetaMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

function clampMetaPanelWidth(width: number): number {
  return Math.min(META_PANEL_MAX, Math.max(META_PANEL_MIN, width));
}

function MetaPanelBody({
  selectionText,
  hasSelection,
  messages,
  streamingContent,
  isStreaming,
  draftQuestion,
  statusText,
  onDraftChange,
  onSubmit,
  onClose,
  onStop,
}: {
  selectionText: string;
  hasSelection: boolean;
  messages: MetaMessage[];
  streamingContent: string;
  isStreaming: boolean;
  draftQuestion: string;
  statusText?: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  onStop: () => void;
}) {
  const askDisabled = !hasSelection || !draftQuestion.trim();

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4 lg:mt-5">
        <span className="text-sm font-semibold">Meta Explain</span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} data-testid="meta-panel-close-button">
          <XIcon className="h-4 w-4" />
          <span className="sr-only">Close Meta Panel</span>
        </Button>
      </div>

      <div className="border-b px-4 py-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Selection
        </p>
        {hasSelection ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
            {selectionText}
          </pre>
        ) : (
          <div className="rounded-md border border-dashed p-3 text-xs leading-relaxed text-muted-foreground">
            Select text in chat and click Explain to start.
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {messages.length === 0 && !isStreaming && (
            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              {hasSelection ? "Ask a follow-up question about the selected content." : "Meta Explain needs a text selection before asking."}
            </div>
          )}

          <div className="space-y-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={msg.role === "user" ? "flex justify-end" : "flex justify-start"}
              >
                {msg.role === "user" ? (
                  <div className="max-w-[92%] whitespace-pre-wrap rounded-lg bg-secondary px-3 py-2 text-sm text-foreground">
                    {msg.content}
                  </div>
                ) : (
                  <div className="max-w-[92%] rounded-lg border px-3 py-2 text-sm">
                    <MessageResponse>{msg.content}</MessageResponse>
                  </div>
                )}
              </div>
            ))}

            {isStreaming && (
              <div className="flex justify-start">
                <div className="max-w-[92%] rounded-lg border px-3 py-2 text-sm">
                  <MessageResponse>{streamingContent || "..."}</MessageResponse>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="border-t p-3">
          <Textarea
            value={draftQuestion}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder={hasSelection ? "Ask a follow-up question..." : "Select text first to ask a question..."}
            className="min-h-[88px] resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!askDisabled) onSubmit();
              }
            }}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{statusText || " "}</span>
            {isStreaming ? (
              <Button size="sm" variant="outline" onClick={onStop}>
                Stop
              </Button>
            ) : (
              <Button size="sm" onClick={onSubmit} disabled={askDisabled}>
                Ask
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MetaPanel() {
  const pathname = usePathname();
  const { sessionId, workingDirectory, panelOpen, previewFile, setPreviewFile } = usePanel();
  const { open, setOpen, selection, requestId, initialQuestion } = useMetaPanel();
  const [isMobile, setIsMobile] = useState(false);
  const [desktopWidth, setDesktopWidth] = useState(() => {
    if (typeof window === "undefined") return META_PANEL_DEFAULT_WIDTH;
    const stored = parseInt(localStorage.getItem(META_PANEL_WIDTH_KEY) || String(META_PANEL_DEFAULT_WIDTH), 10);
    return Number.isNaN(stored) ? META_PANEL_DEFAULT_WIDTH : clampMetaPanelWidth(stored);
  });

  const [messages, setMessages] = useState<MetaMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusText, setStatusText] = useState<string | undefined>();
  const [draftQuestion, setDraftQuestion] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef(0);
  const accumulatedRef = useRef("");

  const isChatRoute = pathname.startsWith("/chat");
  const isChatDetailRoute = pathname.startsWith("/chat/");

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const handleDesktopResize = useCallback((delta: number) => {
    setDesktopWidth((width) => clampMetaPanelWidth(width - delta));
  }, []);

  const handleDesktopResizeEnd = useCallback(() => {
    setDesktopWidth((width) => {
      localStorage.setItem(META_PANEL_WIDTH_KEY, String(width));
      return width;
    });
  }, []);

  const maybeAutoCollapseDocPreview = useCallback(() => {
    if (!open || isMobile || !isChatDetailRoute) return;
    if (!panelOpen || !previewFile) return;
    const main = document.querySelector("main");
    if (!main) return;
    const { width } = main.getBoundingClientRect();
    if (width < MAIN_CONTENT_MIN_WIDTH) {
      setPreviewFile(null);
    }
  }, [open, isMobile, isChatDetailRoute, panelOpen, previewFile, setPreviewFile]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const sendQuestion = useCallback(async (question: string, options?: { reset?: boolean }) => {
    if (!selection) return;
    const trimmed = question.trim();
    if (!trimmed) return;

    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const userMessage: MetaMessage = {
      id: `meta-user-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      role: "user",
      content: trimmed,
    };

    setMessages((prev) => options?.reset ? [userMessage] : [...prev, userMessage]);
    setIsStreaming(true);
    setStreamingContent("");
    accumulatedRef.current = "";
    setStatusText("Connecting...");

    try {
      const response = await fetch("/api/meta-explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedText: selection.text,
          userQuestion: trimmed,
          ...(selection.languageHint ? { languageHint: selection.languageHint } : {}),
          ...(selection.contextLines ? { contextLines: selection.contextLines } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(workingDirectory ? { workingDirectory } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to explain selection");
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response stream");
      }

      const result = await consumeSSEStream(reader, {
        onText: (acc) => {
          if (runId !== activeRunIdRef.current) return;
          accumulatedRef.current = acc;
          setStreamingContent(acc);
        },
        onToolUse: () => {},
        onToolResult: () => {},
        onToolOutput: () => {},
        onToolProgress: () => {},
        onStatus: (text) => {
          if (runId !== activeRunIdRef.current) return;
          setStatusText(text || undefined);
        },
        onResult: () => {},
        onPermissionRequest: () => {},
        onToolTimeout: () => {},
        onError: (acc) => {
          if (runId !== activeRunIdRef.current) return;
          accumulatedRef.current = acc;
          setStreamingContent(acc);
        },
      });

      if (runId !== activeRunIdRef.current) return;

      if (result.accumulated.trim()) {
        const assistantMessage: MetaMessage = {
          id: `meta-assistant-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          role: "assistant",
          content: result.accumulated.trim(),
        };
        setMessages((prev) => [...prev, assistantMessage]);
      }
    } catch (error) {
      if (runId !== activeRunIdRef.current) return;
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const assistantMessage: MetaMessage = {
          id: `meta-error-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          role: "assistant",
          content: `**Error:** ${error instanceof Error ? error.message : "Unknown error"}`,
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } else if (accumulatedRef.current.trim()) {
        const partialMessage: MetaMessage = {
          id: `meta-partial-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          role: "assistant",
          content: `${accumulatedRef.current.trim()}\n\n*(generation stopped)*`,
        };
        setMessages((prev) => [...prev, partialMessage]);
      }
    } finally {
      if (runId !== activeRunIdRef.current) return;
      abortRef.current = null;
      setIsStreaming(false);
      setStreamingContent("");
      accumulatedRef.current = "";
      setStatusText(undefined);
    }
  }, [selection, sessionId, workingDirectory]);

  useEffect(() => {
    if (!open) {
      stopStreaming();
      setMessages([]);
      setStreamingContent("");
      accumulatedRef.current = "";
      setIsStreaming(false);
      setStatusText(undefined);
      setDraftQuestion("");
    }
  }, [open, stopStreaming]);

  useEffect(() => {
    if (open && !isChatRoute) {
      setOpen(false);
    }
  }, [isChatRoute, open, setOpen]);

  useEffect(() => {
    if (open && !isMobile && !isChatDetailRoute) {
      setOpen(false);
    }
  }, [isChatDetailRoute, isMobile, open, setOpen]);

  useEffect(() => {
    if (!open || !selection || requestId <= 0) return;
    setDraftQuestion("");
    sendQuestion(initialQuestion, { reset: true });
  }, [open, selection, requestId, initialQuestion, sendQuestion]);

  useEffect(() => {
    maybeAutoCollapseDocPreview();
  }, [maybeAutoCollapseDocPreview, desktopWidth]);

  useEffect(() => {
    if (!open || isMobile || !isChatDetailRoute || !panelOpen || !previewFile) return;
    const main = document.querySelector("main");
    if (!main || typeof ResizeObserver === "undefined") return;

    let rafId = 0;
    const scheduleCheck = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(maybeAutoCollapseDocPreview);
    };

    const observer = new ResizeObserver(scheduleCheck);
    observer.observe(main);
    window.addEventListener("resize", scheduleCheck);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener("resize", scheduleCheck);
    };
  }, [open, isMobile, isChatDetailRoute, panelOpen, previewFile, maybeAutoCollapseDocPreview]);

  const body = useMemo(() => {
    const hasSelection = Boolean(selection?.text.trim());
    const selectionText = selection?.text || "";
    return (
      <MetaPanelBody
        selectionText={selectionText}
        hasSelection={hasSelection}
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        draftQuestion={draftQuestion}
        statusText={statusText || (hasSelection ? undefined : "Please select text in chat first.")}
        onDraftChange={setDraftQuestion}
        onSubmit={() => {
          const next = draftQuestion.trim();
          if (!next || !hasSelection) return;
          setDraftQuestion("");
          void sendQuestion(next);
        }}
        onClose={() => setOpen(false)}
        onStop={stopStreaming}
      />
    );
  }, [selection, messages, streamingContent, isStreaming, draftQuestion, statusText, sendQuestion, setOpen, stopStreaming]);

  const desktopDock = isChatDetailRoute ? (
    open ? (
      <>
        <div className="hidden lg:block">
          <ResizeHandle
            side="right"
            onResize={handleDesktopResize}
            onResizeEnd={handleDesktopResizeEnd}
          />
        </div>
        <aside
          className="hidden h-full shrink-0 flex-col overflow-hidden border-l bg-background lg:flex"
          style={{ width: desktopWidth }}
          data-testid="meta-panel"
        >
          {body}
        </aside>
      </>
    ) : (
      <div
        className="hidden h-full shrink-0 flex-col items-center gap-2 border-l bg-background p-2 lg:flex"
        data-testid="meta-panel-strip"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setOpen(true)}
              data-testid="meta-panel-open-button"
            >
              <SparklesIcon className="h-4 w-4" />
              <span className="sr-only">Open Meta Panel</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Open Meta Panel</TooltipContent>
        </Tooltip>
      </div>
    )
  ) : null;

  return (
    <>
      {desktopDock}
      {isMobile && (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="right" className="w-full p-0 sm:max-w-none lg:hidden" showCloseButton={false}>
            {body}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
