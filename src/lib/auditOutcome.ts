export const AUDIT_OUTCOME_CLASS: Record<string, string> = {
  executed: "text-success",
  read: "text-success",
  approved: "text-success",
  rejected: "text-destructive",
  pending: "text-muted-foreground",
  failed: "text-destructive",
};

export const AUDIT_OUTCOME_LABEL: Record<string, { fr: string; en: string }> = {
  executed: { fr: "exécutée", en: "executed" },
  read: { fr: "exécutée", en: "executed" },
  approved: { fr: "approuvée", en: "approved" },
  rejected: { fr: "refusée", en: "rejected" },
  pending: { fr: "en attente", en: "pending" },
  failed: { fr: "échouée", en: "failed" },
};
