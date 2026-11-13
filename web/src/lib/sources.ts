/** Where a customer or invoice was made. Records synced from another system are read-only in Drivo. */
export const SOURCE_LABEL: Record<string, string> = { billzilla: "BillZilla", xero: "Xero", csv: "Import", manual: "Drivo" };
export const sourceLabel = (source: string | null | undefined) => SOURCE_LABEL[source ?? ""] ?? "Drivo";
export const isSynced = (source: string | null | undefined) => source === "billzilla" || source === "xero";
