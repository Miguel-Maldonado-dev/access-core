export interface LogFilterState {
  dateFrom?: string;
  dateTo?: string;
  holderId?: number;
  allowed?: boolean;
  source?: number;
}

export function buildLogQuery(f: LogFilterState, page: number, pageSize: number): string {
  const params = new URLSearchParams();
  if (f.dateFrom) params.set("date_from", f.dateFrom);
  if (f.dateTo) params.set("date_to", f.dateTo);
  if (f.holderId !== undefined) params.set("holder_id", String(f.holderId));
  if (f.allowed !== undefined) params.set("allowed", String(f.allowed));
  if (f.source !== undefined) params.set("source", String(f.source));
  params.set("page", String(page));
  params.set("page_size", String(pageSize));
  return params.toString();
}
