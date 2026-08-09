import { z } from "zod";

const httpsUrl = z.url().refine((value) => new URL(value).protocol === "https:", {
  message: "Only HTTPS merchant URLs are allowed",
});

export const shoppingItemSchema = z.object({
  query: z.string().trim().min(2).max(300),
  quantity: z.number().int().min(1).max(25).default(1),
  maxUnitPrice: z.number().positive().max(100_000).optional(),
  preferences: z.record(z.string(), z.string().max(500)).default({}),
  allowSubstitutions: z.boolean().default(false),
});

export const createRunSchema = z.object({
  listId: z.uuid(),
  merchantUrl: httpsUrl,
  items: z.array(shoppingItemSchema).min(1).max(50),
  budget: z.number().positive().max(1_000_000),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  paymentMode: z.enum(["saved_merchant", "secure_handoff"]).default("secure_handoff"),
  browserbaseContextId: z.string().trim().min(1).max(200).optional(),
});

export const approvalSchema = z.object({
  approvedMaximum: z.number().positive().max(1_000_000),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
});

export type CreateRunInput = z.infer<typeof createRunSchema>;
export type ApprovalInput = z.infer<typeof approvalSchema>;

export function merchantOrigin(url: string): string {
  return new URL(url).origin;
}

export function isSameMerchant(candidate: string, merchantUrl: string): boolean {
  try {
    const merchant = new URL(merchantUrl);
    const target = new URL(candidate);
    return target.protocol === "https:" &&
      (target.hostname === merchant.hostname || target.hostname.endsWith(`.${merchant.hostname}`));
  } catch {
    return false;
  }
}
