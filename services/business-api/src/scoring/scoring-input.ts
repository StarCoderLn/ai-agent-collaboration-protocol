import { z } from "zod";

const ratingSchema = z.object({
  quality: z.number().int().min(1).max(5),
  communication: z.number().int().min(1).max(5),
}).strict();

export type RatingInput = z.infer<typeof ratingSchema>;

export function parseRatingInput(value: unknown) {
  const result = ratingSchema.safeParse(value);
  return result.success
    ? { success: true as const, data: result.data }
    : {
      success: false as const,
      issues: result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    };
}
