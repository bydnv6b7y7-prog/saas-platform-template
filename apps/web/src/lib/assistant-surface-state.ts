type AssistantSurfaceState = {
  compactModalOpen: boolean;
  appShellInert: boolean;
  sidebarInert: boolean;
};

export function resolveAssistantSurfaceState({
  appShellWasInert,
  compact,
  open,
}: {
  appShellWasInert: boolean;
  compact: boolean;
  open: boolean;
}): AssistantSurfaceState {
  const compactModalOpen = open && compact;

  return {
    compactModalOpen,
    appShellInert: appShellWasInert || compactModalOpen,
    sidebarInert: !open,
  };
}
