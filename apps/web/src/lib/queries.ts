import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Account,
  Category,
  DebtBudgetRow,
  DebtDetail,
  DebtPlan,
  DebtRow,
  InvestmentDetail,
  InvestmentOverview,
  InvestmentRow,
  InvestmentSettings,
  InvoicePreview,
  InvoiceRow,
  ItemDetail,
  ItemType,
  Me,
  MonthsRange,
  NotificationSettings,
  OccurrenceRow,
  Person,
  Summary,
} from '@ff/shared';
import { api, ApiError } from './api';

/** Consultas e mutações da API, com as chaves de cache num lugar só (ADR-0009). */

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/me'), staleTime: 300_000, retry: false });

const W = (w: string) => `/api/wallets/${w}`;

export const useCategories = (w: string) => useQuery({ queryKey: ['categories', w], queryFn: () => api.get<Category[]>(`${W(w)}/categories`), enabled: !!w });
export const usePeople = (w: string) => useQuery({ queryKey: ['people', w], queryFn: () => api.get<Person[]>(`${W(w)}/people`), enabled: !!w });
export const useAccounts = (w: string) => useQuery({ queryKey: ['accounts', w], queryFn: () => api.get<Account[]>(`${W(w)}/accounts`), enabled: !!w });
export const useMonths = (w: string) => useQuery({ queryKey: ['months', w], queryFn: () => api.get<MonthsRange>(`${W(w)}/months`), enabled: !!w });
export const useSummary = (w: string, month: string) =>
  useQuery({ queryKey: ['summary', w, month], queryFn: () => api.get<Summary>(`${W(w)}/summary?month=${month}`), enabled: !!w && !!month });
export const useInvoices = (w: string, month: string) =>
  useQuery({ queryKey: ['invoices', w, month], queryFn: () => api.get<InvoiceRow[]>(`${W(w)}/invoices?month=${month}`), enabled: !!w && !!month });

export interface OccFilters {
  month: string;
  type: ItemType;
  recurring?: boolean;
  onlyOpen?: boolean;
}
export const useOccurrences = (w: string, f: OccFilters) =>
  useQuery({
    queryKey: ['occurrences', w, f],
    queryFn: () => {
      const q = new URLSearchParams({ month: f.month, type: f.type });
      if (f.recurring) q.set('recurring', 'true');
      if (f.onlyOpen) q.set('onlyOpen', 'true');
      return api.get<OccurrenceRow[]>(`${W(w)}/occurrences?${q}`);
    },
    enabled: !!w && !!f.month,
    placeholderData: (prev) => prev,
  });

export const useItem = (w: string, id: string | null) =>
  useQuery({ queryKey: ['item', w, id], queryFn: () => api.get<ItemDetail>(`${W(w)}/items/${id}`), enabled: !!w && !!id });

export const useInvoicePreview = (w: string, account: string | null | undefined, date: string) =>
  useQuery({
    queryKey: ['invoice-preview', w, account, date],
    queryFn: () => api.get<InvoicePreview>(`${W(w)}/invoice-preview?account=${account}&date=${date}`),
    enabled: !!w && !!account && /^\d{4}-\d{2}-\d{2}$/.test(date),
  });

export const useNotificationSettings = () =>
  useQuery({ queryKey: ['notification-settings'], queryFn: () => api.get<NotificationSettings>('/api/me/notification-settings') });

/** Depois de qualquer mudança de lançamentos, tudo que depende deles recarrega. */
export function invalidateFinance(w: string) {
  for (const k of ['occurrences', 'summary', 'invoices', 'months', 'item']) void queryClient.invalidateQueries({ queryKey: [k, w] });
}

export function useFinanceMutation<TVars, TRes = unknown>(w: string, fn: (vars: TVars) => Promise<TRes>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      invalidateFinance(w);
      void qc.invalidateQueries({ queryKey: ['categories', w] });
      void qc.invalidateQueries({ queryKey: ['people', w] });
    },
  });
}

export const walletUrl = W;

// ---------- Dívidas (ADR-0011): módulo isolado; não mexe nas chaves do mês.
export const useDebts = (w: string) => useQuery({ queryKey: ['debts', w], queryFn: () => api.get<DebtRow[]>(`${W(w)}/debts`), enabled: !!w });
export const useDebt = (w: string, id: string | null) =>
  useQuery({ queryKey: ['debts', w, id], queryFn: () => api.get<DebtDetail>(`${W(w)}/debts/${id}`), enabled: !!w && !!id });
export const useDebtPlan = (w: string) => useQuery({ queryKey: ['debt-plan', w], queryFn: () => api.get<DebtPlan>(`${W(w)}/debt-plan`), enabled: !!w });
export const useDebtBudgets = (w: string) =>
  useQuery({ queryKey: ['debt-budgets', w], queryFn: () => api.get<DebtBudgetRow[]>(`${W(w)}/debt-budgets`), enabled: !!w });

/** Depois de qualquer mudança no módulo de dívidas: lista, detalhe, plano e orçamento recarregam. */
export function invalidateDebts(w: string) {
  // A amortização extra entra no balanço do mês (ADR-0012): o resumo recarrega junto.
  for (const k of ['debts', 'debt-plan', 'debt-budgets', 'summary']) void queryClient.invalidateQueries({ queryKey: [k, w] });
}

// ---------- Investimentos em caixinhas (ADR-0012): módulo isolado; só o resumo do mês o lê.
export const useInvestments = (w: string) =>
  useQuery({ queryKey: ['investments', w], queryFn: () => api.get<InvestmentRow[]>(`${W(w)}/investments`), enabled: !!w });
export const useInvestment = (w: string, id: string | null) =>
  useQuery({ queryKey: ['investments', w, id], queryFn: () => api.get<InvestmentDetail>(`${W(w)}/investments/${id}`), enabled: !!w && !!id });
export const useInvestmentOverview = (w: string) =>
  useQuery({ queryKey: ['investment-overview', w], queryFn: () => api.get<InvestmentOverview>(`${W(w)}/investments/overview`), enabled: !!w });
export const useInvestmentSettings = (w: string) =>
  useQuery({ queryKey: ['investment-settings', w], queryFn: () => api.get<InvestmentSettings>(`${W(w)}/investment-settings`), enabled: !!w });

/** Depois de qualquer mudança nas caixinhas: lista, detalhe, visão geral, CDI e o resumo do mês recarregam. */
export function invalidateInvestments(w: string) {
  for (const k of ['investments', 'investment-overview', 'investment-settings', 'summary']) void queryClient.invalidateQueries({ queryKey: [k, w] });
}
