"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { consumeSSEStream } from "@/hooks/useSSEStream";
import { usePanel } from "@/hooks/usePanel";
import { MessageResponse } from "@/components/ai-elements/message";
import { useMetaPanel } from "./MetaPanelContext";

interface MetaMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

function MetaPanelBody({
  selectionText,
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
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <span className="text-sm font-semibold">Meta Explain</span>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <XIcon className="h-4 w-4" />
          <span className="sr-only">Close Meta Panel</span>
        </Button>
      </div>

      <div className="border-b px-4 py-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Selection
        </p>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
          {selectionText}
        </pre>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {messages.length === 0 && !isStreaming && (
            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              Ask a follow-up question about the selected content.
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
            placeholder="Ask a follow-up question..."
            className="min-h-[88px] resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
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
              <Button size="sm" onClick={onSubmit} disabled={!draftQuestion.trim()}>
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
  const { sessionId, workingDirectory } = usePanel();
  const { open, setOpen, selection, requestId, initialQuestion } = useMetaPanel();
  const [isMobile, setIsMobile] = useState(false);

  const [messages, setMessages] = useState<MetaMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusText, setStatusText] = useState<string | undefined>();
  const [draftQuestion, setDraftQuestion] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef(0);
  const accumulatedRef = useRef("");

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

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
    if (open && !pathname.startsWith("/chat")) {
      setOpen(false);
    }
  }, [open, pathname, setOpen]);

  useEffect(() => {
    if (!open || !selection || requestId <= 0) return;
    setDraftQuestion("");
    sendQuestion(initialQuestion, { reset: true });
  }, [open, selection, requestId, initialQuestion, sendQuestion]);

  const body = useMemo(() => {
    const selectionText = selection?.text || "";
    return (
      <MetaPanelBody
        selectionText={selectionText}
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        draftQuestion={draftQuestion}
        statusText={statusText}
        onDraftChange={setDraftQuestion}
        onSubmit={() => {
          const next = draftQuestion.trim();
          if (!next) return;
          setDraftQuestion("");
          void sendQuestion(next);
        }}
        onClose={() => setOpen(false)}
        onStop={stopStreaming}
      />
    );
  }, [selection, messages, streamingContent, isStreaming, draftQuestion, statusText, sendQuestion, setOpen, stopStreaming]);

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-[60] hidden lg:block">
          <button
            className="absolute inset-0 bg-black/15"
            onClick={() => setOpen(false)}
            aria-label="Close Meta Panel"
          />
          <aside className="absolute inset-y-0 right-0 w-[min(440px,92vw)] border-l bg-background shadow-2xl">
            {body}
          </aside>
        </div>
      )}

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
