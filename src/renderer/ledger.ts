import type { Expense, Batch } from './model.ts';
export type AdvanceDetails = {
  date?: string;
  note?: string;
  createdAt?: string;
  attachmentId?: string;
  deleted?: boolean;
};
// Optional metadata keyed by the immutable index in advances; never another amount source.
export type BatchEvent = {
  requestId: string;
  action: 'delete-batch';
  at: string;
  batchId: number;
  before: Batch;
  after: null;
};
export type ExpenseEvent = {
  requestId: string;
  action: 'correct-expense' | 'delete-expense' | 'set-invoice-issued';
  at: string;
  expenseId: number;
  revision: number;
  before: Expense;
  after: Expense | null;
};
export type AdvanceEvent = {
  requestId: string;
  action: 'correct-advance' | 'delete-advance';
  at: string;
  advanceId: number;
  revision: number;
  before: { amount: number; details: AdvanceDetails | null };
  after: { amount: number; details: AdvanceDetails | null } | null;
};
export type LedgerState = {
  expenses: Expense[];
  batches: Batch[];
  advances: number[];
  advanceDetails?: Record<number, AdvanceDetails>;
  batchEvents?: BatchEvent[];
  expenseEvents?: ExpenseEvent[];
  advanceEvents?: AdvanceEvent[];
  generation?: string;
};
declare global {
  interface Window {
    localLedger?: { command: (payload: unknown) => Promise<unknown> };
  }
}
// A tab keeps the generation it loaded and sends it with every change. Clearing or
// restoring the ledger gives it a new generation, so a stale tab cannot write into it.
// Maintenance-info must never refresh this token.
let loadedGeneration: string | undefined;
const WITHOUT_GENERATION = ['read', 'maintenance-info', 'attachment', 'show-folder'];

// The desktop bridge wraps every refusal as “Error invoking remote method …: Error: 原因”.
// Only the reason is meant for the user.
const BRIDGE_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;
export function plainMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text.replace(BRIDGE_PREFIX, '') || '本地读写失败，请重试';
}

// A save refused because this window shows out-of-date records ends with “请刷新后…”.
// The desktop window has no refresh button, so the ledger is read again right away,
// the screens are told (onLedgerReloaded), and the message says what happened.
const ASKS_FOR_REFRESH = /，请刷新(?:页面)?后[^，。]*$/;
const reloadListeners = new Set<(state: LedgerState) => void>();
export function onLedgerReloaded(listener: (state: LedgerState) => void) {
  reloadListeners.add(listener);
  return () => {
    reloadListeners.delete(listener);
  };
}
async function explainRefusal(error: unknown): Promise<Error> {
  const text = plainMessage(error);
  if (!ASKS_FOR_REFRESH.test(text)) return Error(text);
  try {
    const state = await ledgerCommand({ kind: 'read' });
    for (const listener of reloadListeners) listener(state);
  } catch {
    return Error(text);
  }
  return Error(text.replace(ASKS_FOR_REFRESH, '。已重新读取最新账本，请核对后再保存。'));
}

export async function ledgerCommand<T = LedgerState>(payload: unknown): Promise<T> {
  try {
    return await send<T>(payload);
  } catch (error) {
    throw (payload as { kind?: unknown })?.kind === 'read'
      ? Error(plainMessage(error))
      : await explainRefusal(error);
  }
}
async function send<T>(payload: unknown): Promise<T> {
  const input = payload as Record<string, unknown>;
  const request =
    input &&
    typeof input === 'object' &&
    !WITHOUT_GENERATION.includes(input.kind as string) &&
    loadedGeneration &&
    !Object.hasOwn(input, 'generation')
      ? { ...input, generation: loadedGeneration }
      : payload;
  let result: any;
  if (window.localLedger) result = await window.localLedger.command(request);
  else {
    const response = await fetch('/api/ledger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ledger-Request': '1' },
      body: JSON.stringify(request),
      cache: 'no-store',
    });
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw Error('本地账本服务暂时不可用，请关闭并重新打开钱来');
    result = await response.json();
    if (!response.ok) throw Error(result.error || '本地读写失败');
  }
  if (input?.kind === 'read')
    loadedGeneration = typeof result?.generation === 'string' ? result.generation : undefined;
  return result as T;
}
export async function imagePayload(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { base64: btoa(value) };
}
