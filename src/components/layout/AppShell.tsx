"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NavRail } from "./NavRail";
import { ChatListPanel } from "./ChatListPanel";
import { RightPanel } from "./RightPanel";
import { UpdateDialog } from "./UpdateDialog";
import { PanelContext, type PanelContent } from "@/hooks/usePanel";
import { UpdateContext, type UpdateInfo } from "@/hooks/useUpdate";

const LG_BREAKPOINT = 1024;
const CHECK_INTERVAL = 8 * 60 * 60 * 1000; // 8 hours
const DISMISSED_VERSION_KEY = "codepilot_dismissed_update_version";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const [chatListOpen, setChatListOpenRaw] = useState(false);

  // Panel state
  const isChatRoute = pathname.startsWith("/chat/") || pathname === "/chat";
  const isChatDetailRoute = pathname.startsWith("/chat/");

  // Auto-close chat list when leaving chat routes
  const setChatListOpen = useCallback((open: boolean) => {
    setChatListOpenRaw(open);
  }, []);

  useEffect(() => {
    if (!isChatRoute) {
      setChatListOpenRaw(false);
    }
  }, [isChatRoute]);
  const [panelOpen, setPanelOpenRaw] = useState(false);
  const [panelContent, setPanelContent] = useState<PanelContent>("files");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [sessionTitle, setSessionTitle] = useState("");
  const [streamingSessionId, setStreamingSessionId] = useState("");
  const [pendingApprovalSessionId, setPendingApprovalSessionId] = useState("");

  // Auto-open panel on chat detail routes, close on others
  useEffect(() => {
    setPanelOpenRaw(isChatDetailRoute);
  }, [isChatDetailRoute]);

  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenRaw(open);
  }, []);

  // Keep chat list state in sync when resizing across the breakpoint (only on chat routes)
  useEffect(() => {
    if (!isChatRoute) return;
    const mql = window.matchMedia(`(min-width: ${LG_BREAKPOINT}px)`);
    const handler = (e: MediaQueryListEvent) => setChatListOpenRaw(e.matches);
    mql.addEventListener("change", handler);
    setChatListOpenRaw(mql.matches);
    return () => mql.removeEventListener("change", handler);
  }, [isChatRoute]);

  // --- Skip-permissions indicator ---
  const [skipPermissionsActive, setSkipPermissionsActive] = useState(false);

  const fetchSkipPermissions = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/app");
      if (res.ok) {
        const data = await res.json();
        setSkipPermissionsActive(data.settings?.dangerously_skip_permissions === "true");
      }
    } catch {
      // ignore
    }
  }, []);

  // Poll periodically so the indicator stays in sync when settings change
  useEffect(() => {
    fetchSkipPermissions();
    const id = setInterval(fetchSkipPermissions, 5000);
    return () => clearInterval(id);
  }, [fetchSkipPermissions]);

  // --- Update check state ---
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [showDialog, setShowDialog] = useState(false);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/app/updates");
      if (!res.ok) return;
      const data: UpdateInfo = await res.json();
      setUpdateInfo(data);

      if (data.updateAvailable) {
        const dismissed = localStorage.getItem(DISMISSED_VERSION_KEY);
        if (dismissed !== data.latestVersion) {
          setShowDialog(true);
        }
      }
    } catch {
      // silently ignore network errors
    } finally {
      setChecking(false);
    }
  }, []);

  const dismissUpdate = useCallback(() => {
    setShowDialog(false);
    if (updateInfo?.latestVersion) {
      localStorage.setItem(DISMISSED_VERSION_KEY, updateInfo.latestVersion);
    }
  }, [updateInfo]);

  // Check on mount + every 8 hours
  useEffect(() => {
    checkForUpdates();
    const id = setInterval(checkForUpdates, CHECK_INTERVAL);
    return () => clearInterval(id);
  }, [checkForUpdates]);

  const updateContextValue = useMemo(
    () => ({
      updateInfo,
      checking,
      checkForUpdates,
      dismissUpdate,
      showDialog,
      setShowDialog,
    }),
    [updateInfo, checking, checkForUpdates, dismissUpdate, showDialog]
  );

  const panelContextValue = useMemo(
    () => ({
      panelOpen,
      setPanelOpen,
      panelContent,
      setPanelContent,
      workingDirectory,
      setWorkingDirectory,
      sessionId,
      setSessionId,
      sessionTitle,
      setSessionTitle,
      streamingSessionId,
      setStreamingSessionId,
      pendingApprovalSessionId,
      setPendingApprovalSessionId,
    }),
    [panelOpen, setPanelOpen, panelContent, workingDirectory, sessionId, sessionTitle, streamingSessionId, pendingApprovalSessionId]
  );

  return (
    <UpdateContext.Provider value={updateContextValue}>
      <PanelContext.Provider value={panelContextValue}>
        <TooltipProvider delayDuration={300}>
          <div className="flex h-screen overflow-hidden">
            <NavRail
              chatListOpen={chatListOpen}
              onToggleChatList={() => setChatListOpen(!chatListOpen)}
              hasUpdate={updateInfo?.updateAvailable ?? false}
              skipPermissionsActive={skipPermissionsActive}
            />
            <ChatListPanel open={chatListOpen} />
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {/* Electron draggable title bar region */}
              <div
                className="h-11 w-full shrink-0"
                style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
              />
              <main className="relative flex-1 overflow-hidden">{children}</main>
            </div>
            {isChatDetailRoute && <RightPanel />}
          </div>
          <UpdateDialog />
        </TooltipProvider>
      </PanelContext.Provider>
    </UpdateContext.Provider>
  );
}
