import type { GroupSession } from './groupSessionService';

export type AnnotationPoint = {
  x: number;
  y: number;
};

export type AnnotationTool = 'pen' | 'line' | 'circle' | 'arrow' | 'rect' | 'text' | 'eraser';

export type AnnotationAction = {
  actionId: string;
  tool: AnnotationTool;
  points: AnnotationPoint[];
  color: string;
  lineWidth: number;
  text?: string;
  userId: number;
  createdAt: string;
};

export type AnnotationDraft = Omit<AnnotationAction, 'userId' | 'createdAt'>;

export interface ScreenAnnotationStore {
  get(key: string): Promise<AnnotationAction[]>;
  set(key: string, actions: AnnotationAction[]): Promise<void>;
  delete(key: string): Promise<void>;
}

const MAX_ACTIONS = 1000;
const MAX_POINTS = 5000;
const HEX_COLOR = /^#[0-9A-F]{6}$/i;
const TOOLS = new Set<AnnotationTool>(['pen', 'line', 'circle', 'arrow', 'rect', 'text', 'eraser']);

export class ScreenAnnotationService {
  constructor(private readonly store: ScreenAnnotationStore) {}

  private getKey(session: GroupSession) {
    return `group:annotation:${session.groupId}:${session.startedAt}`;
  }

  assertOwner(session: GroupSession, userId: number) {
    if (session.type !== 'screen' || session.ownerUserId !== userId) {
      throw new Error('只有当前屏幕共享者可以标注');
    }
  }

  validateAction(action: AnnotationAction) {
    if (
      !action.actionId ||
      !TOOLS.has(action.tool) ||
      action.points.length === 0 ||
      action.points.length > MAX_POINTS
    ) {
      throw new Error('标注数据无效');
    }
    if (!HEX_COLOR.test(action.color) || action.lineWidth <= 0 || action.lineWidth > 0.05) {
      throw new Error('标注样式无效');
    }
    if (action.text && action.text.length > 500) {
      throw new Error('标注文字过长');
    }
    if (
      action.points.some(
        (point) =>
          !Number.isFinite(point.x) ||
          !Number.isFinite(point.y) ||
          point.x < 0 ||
          point.x > 1 ||
          point.y < 0 ||
          point.y > 1,
      )
    ) {
      throw new Error('标注坐标无效');
    }
  }

  validateDraft(session: GroupSession, userId: number, draft: AnnotationDraft) {
    this.assertOwner(session, userId);
    this.validateAction({
      ...draft,
      userId,
      createdAt: new Date().toISOString(),
    });
    return draft;
  }

  async getSnapshot(session: GroupSession) {
    return this.store.get(this.getKey(session));
  }

  async complete(session: GroupSession, userId: number, action: AnnotationAction) {
    this.assertOwner(session, userId);
    this.validateAction(action);
    const actions = await this.getSnapshot(session);
    const existing = actions.find((item) => item.actionId === action.actionId);
    if (existing) return existing;
    if (actions.length >= MAX_ACTIONS) {
      throw new Error('标注数量已达上限，请先清空');
    }

    const saved = { ...action, userId };
    await this.store.set(this.getKey(session), [...actions, saved]);
    return saved;
  }

  async undo(session: GroupSession, userId: number) {
    this.assertOwner(session, userId);
    const actions = await this.getSnapshot(session);
    const removed = actions.pop();
    await this.store.set(this.getKey(session), actions);
    return removed?.actionId ?? null;
  }

  async clear(session: GroupSession, userId: number) {
    this.assertOwner(session, userId);
    await this.store.delete(this.getKey(session));
  }

  async end(session: GroupSession) {
    await this.store.delete(this.getKey(session));
  }
}
