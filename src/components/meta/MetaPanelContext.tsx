"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export interface MetaSelection {
  text: string;
  languageHint?: string;
  contextLines?: string;
}

interface MetaPanelContextValue {
  open: boolean;
  selection: MetaSelection | null;
  requestId: number;
  initialQuestion: string;
  setOpen: (open: boolean) => void;
  startExplain: (selection: MetaSelection, initialQuestion?: string) => void;
}

const MetaPanelContext = createContext<MetaPanelContextValue | null>(null);

export function MetaPanelProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<MetaSelection | null>(null);
  const [requestId, setRequestId] = useState(0);
  const [initialQuestion, setInitialQuestion] = useState("Explain this");

  const startExplain = useCallback((nextSelection: MetaSelection, question: string = "Explain this") => {
    setSelection(nextSelection);
    setInitialQuestion(question);
    setRequestId((id) => id + 1);
    setOpen(true);
  }, []);

  const value = useMemo<MetaPanelContextValue>(() => ({
    open,
    selection,
    requestId,
    initialQuestion,
    setOpen,
    startExplain,
  }), [open, selection, requestId, initialQuestion, startExplain]);

  return (
    <MetaPanelContext.Provider value={value}>
      {children}
    </MetaPanelContext.Provider>
  );
}

export function useMetaPanel(): MetaPanelContextValue {
  const ctx = useContext(MetaPanelContext);
  if (!ctx) {
    throw new Error("useMetaPanel must be used within MetaPanelProvider");
  }
  return ctx;
}
