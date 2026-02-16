"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useMetaPanel } from "./MetaPanelContext";

interface PopoverState {
  text: string;
  languageHint?: string;
  top: number;
  left: number;
}

function getElementFromNode(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

function findSelectionRoot(node: Node | null): Element | null {
  const element = getElementFromNode(node);
  return element?.closest('[data-meta-selection-root="true"]') ?? null;
}

function detectLanguage(node: Node | null): string | undefined {
  const element = getElementFromNode(node);
  if (!element) return undefined;

  const explicit = element.closest("[data-language]");
  const attrLang = explicit?.getAttribute("data-language");
  if (attrLang) return attrLang;

  const code = element.closest("code[class*='language-'], pre code[class*='language-']");
  if (code) {
    for (const className of Array.from(code.classList)) {
      if (className.startsWith("language-")) {
        return className.slice("language-".length);
      }
    }
  }
  return undefined;
}

export function SelectionPopover() {
  const pathname = usePathname();
  const { startExplain } = useMetaPanel();
  const [state, setState] = useState<PopoverState | null>(null);

  const hide = useCallback(() => {
    setState(null);
  }, []);

  useEffect(() => {
    if (!pathname.startsWith("/chat")) {
      const raf = window.requestAnimationFrame(() => hide());
      return () => window.cancelAnimationFrame(raf);
    }

    const updateFromSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        hide();
        return;
      }

      const rawText = selection.toString();
      if (!rawText.trim()) {
        hide();
        return;
      }
      const text = rawText;

      const anchorRoot = findSelectionRoot(selection.anchorNode);
      const focusRoot = findSelectionRoot(selection.focusNode);
      if (!anchorRoot || !focusRoot || anchorRoot !== focusRoot) {
        hide();
        return;
      }

      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if ((rect.width === 0 && rect.height === 0) || Number.isNaN(rect.top)) {
        hide();
        return;
      }

      const top = Math.max(8, rect.top - 40);
      const left = Math.max(56, Math.min(window.innerWidth - 56, rect.left + rect.width / 2));
      setState({
        text,
        languageHint: detectLanguage(selection.anchorNode),
        top,
        left,
      });
    };

    const handleSelectionChange = () => {
      window.requestAnimationFrame(updateFromSelection);
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);

    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [pathname, hide]);

  if (!pathname.startsWith("/chat") || !state) return null;

  return (
    <div
      className="fixed z-[70] -translate-x-1/2"
      style={{ top: state.top, left: state.left }}
    >
      <Button
        size="sm"
        className="h-8 rounded-full px-3 text-xs shadow-md"
        onClick={() => {
          startExplain({
            text: state.text,
            languageHint: state.languageHint,
          });
          window.getSelection()?.removeAllRanges();
          hide();
        }}
      >
        Explain
      </Button>
    </div>
  );
}
