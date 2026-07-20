/** In-memory last-list store for WhatsApp numbered task shortcuts. TTL 30 minutes. */

export type TaskListItem = {
  n: number;
  taskId: string;
  title: string;
};

type SessionEntry = {
  items: TaskListItem[];
  expiresAt: number;
};

const TASK_LIST_TTL_MS = 30 * 60 * 1000;
const lastTaskLists = new Map<string, SessionEntry>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of lastTaskLists) {
    if (entry.expiresAt <= now) lastTaskLists.delete(key);
  }
}

export function saveTaskList(
  phoneLocal: string,
  items: Array<{ taskId: string; title: string }>
): TaskListItem[] {
  pruneExpired();
  const key = phoneLocal.trim();
  if (!key) return [];

  const numbered: TaskListItem[] = items.map((item, i) => ({
    n: i + 1,
    taskId: item.taskId,
    title: item.title,
  }));

  if (numbered.length === 0) {
    lastTaskLists.delete(key);
    return [];
  }

  lastTaskLists.set(key, {
    items: numbered,
    expiresAt: Date.now() + TASK_LIST_TTL_MS,
  });
  return numbered;
}

export function getTaskByNumber(
  phoneLocal: string,
  n: number
): TaskListItem | null {
  pruneExpired();
  const key = phoneLocal.trim();
  if (!key || !Number.isInteger(n) || n < 1) return null;

  const entry = lastTaskLists.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) lastTaskLists.delete(key);
    return null;
  }

  return entry.items.find((item) => item.n === n) ?? null;
}

export function hasTaskList(phoneLocal: string): boolean {
  pruneExpired();
  const key = phoneLocal.trim();
  if (!key) return false;
  const entry = lastTaskLists.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) lastTaskLists.delete(key);
    return false;
  }
  return entry.items.length > 0;
}
