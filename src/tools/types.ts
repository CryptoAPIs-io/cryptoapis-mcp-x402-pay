import type * as z from "zod";

/** Tool definition for the x402 MCP (local orchestration; no shared HTTP client). */
export type McpX402ToolDef<TSchema extends z.ZodTypeAny> = {
    name: string;
    description: string;
    inputSchema: TSchema;
    handler: (input: z.infer<TSchema>) => Promise<{ content: { type: "text"; text: string }[] }>;
};
