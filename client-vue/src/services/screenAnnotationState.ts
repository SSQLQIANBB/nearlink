import { shallowReadonly, shallowRef } from 'vue';

export type AnnotationPoint = {
  x: number;
  y: number;
};

export type AnnotationTool = 'pen' | 'line' | 'circle' | 'arrow' | 'rect' | 'text' | 'eraser';

export type AnnotationDraft = {
  actionId: string;
  tool: AnnotationTool;
  points: AnnotationPoint[];
  color: string;
  lineWidth: number;
  text?: string;
};

export type AnnotationAction = AnnotationDraft & {
  userId: number;
  createdAt: string;
};

export function createScreenAnnotationState() {
  const actions = shallowRef<AnnotationAction[]>([]);
  const drafts = shallowRef<AnnotationDraft[]>([]);
  let currentStartedAt: string | null = null;

  function matchesSession(startedAt: string) {
    return currentStartedAt === startedAt;
  }

  function startSession(startedAt: string) {
    if (currentStartedAt === startedAt) return;
    currentStartedAt = startedAt;
    actions.value = [];
    drafts.value = [];
  }

  function applySnapshot(startedAt: string, nextActions: AnnotationAction[]) {
    if (!matchesSession(startedAt)) return false;
    actions.value = [...new Map(nextActions.map((action) => [action.actionId, action])).values()];
    drafts.value = [];
    return true;
  }

  function applyDraft(startedAt: string, draft: AnnotationDraft) {
    if (!matchesSession(startedAt)) return false;
    if (actions.value.some((action) => action.actionId === draft.actionId)) return true;
    const next = new Map(drafts.value.map((item) => [item.actionId, item]));
    next.set(draft.actionId, draft);
    drafts.value = [...next.values()];
    return true;
  }

  function applyComplete(startedAt: string, action: AnnotationAction) {
    if (!matchesSession(startedAt)) return false;
    drafts.value = drafts.value.filter((item) => item.actionId !== action.actionId);
    const next = new Map(actions.value.map((item) => [item.actionId, item]));
    next.set(action.actionId, action);
    actions.value = [...next.values()];
    return true;
  }

  function applyUndo(startedAt: string, actionId: string | null) {
    if (!matchesSession(startedAt)) return false;
    if (actionId) {
      actions.value = actions.value.filter((action) => action.actionId !== actionId);
      drafts.value = drafts.value.filter((draft) => draft.actionId !== actionId);
    }
    return true;
  }

  function clear() {
    currentStartedAt = null;
    actions.value = [];
    drafts.value = [];
  }

  return {
    actions: shallowReadonly(actions),
    drafts: shallowReadonly(drafts),
    startSession,
    applySnapshot,
    applyDraft,
    applyComplete,
    applyUndo,
    clear,
  };
}
