import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const pressureSchema = z
  .object({
    avg10: z.number().min(0).max(100),
    avg60: z.number().min(0).max(100),
  })
  .strict();

const hostLoadSchema = z
  .object({
    memoryAvailableBytes: z.number().int().nonnegative(),
    memoryTotalBytes: z.number().int().positive(),
    cpuPressure: pressureSchema,
    memoryPressure: pressureSchema,
  })
  .strict();

export type HostLoad = z.infer<typeof hostLoadSchema>;

export const concurrencyLimitHostContract = defineRpcContract({
  getCapacity: {
    input: z.null(),
    output: z
      .object({
        availableParallelism: z.number().int().positive(),
        load: hostLoadSchema.nullable(),
      })
      .strict(),
  },
});
