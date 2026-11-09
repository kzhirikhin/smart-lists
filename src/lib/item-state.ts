import { z } from "zod";

/** Короткое пояснение текущего состояния; не меняет статус выполнения. */
export const MAX_ITEM_STATE_LENGTH = 120;

/** Один контракт для сохранения подписи и повторной проверки перед AI. */
export const itemStateTextSchema = z.string().trim().max(MAX_ITEM_STATE_LENGTH)
  .refine((value) => !/[\r\n]/.test(value));

/** Повреждённое значение не расширяет AI-контекст за пределы контракта. */
export function itemStateForInsight(value: unknown): string | null {
  const result = itemStateTextSchema.safeParse(value);
  return result.success ? result.data || null : null;
}
