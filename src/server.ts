import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpLogger } from "@cryptoapis-io/mcp-shared";
import { tools } from "./tools/index.js";

const CRYPTOAPIS_SERVER_INFO = {
    name: "mcp-x402-pay",
    version: "0.1.0",
    title: "MCP x402 — pay paywalled HTTP endpoints",
    websiteUrl: "https://developers.cryptoapis.io",
    icons: [
        { src: "https://cryptoapis.io/cryptoapis/images/logo.svg", mimeType: "image/svg+xml", sizes: ["any"], theme: "light" as const },
        { src: "https://cryptoapis.io/cryptoapis/images/logo-black.svg", mimeType: "image/svg+xml", sizes: ["any"], theme: "dark" as const },
    ],
};

/**
 * Build and run the x402 MCP server. Stdio-only (no HTTP) for security: the buyer's
 * private key is passed per request and no network server is exposed.
 */
export async function startX402Server(): Promise<void> {
    const server = new McpServer(CRYPTOAPIS_SERVER_INFO);
    const logger = new McpLogger((params) => server.sendLoggingMessage(params), CRYPTOAPIS_SERVER_INFO.name);

    for (const t of tools) {
        server.registerTool(
            t.name,
            { description: t.description, inputSchema: t.inputSchema },
            async (input: unknown) => {
                logger.logDebug({ tool: t.name, event: "tool_call" });
                const result = await (t.handler as (input: unknown) => Promise<{ content: { type: "text"; text: string }[] }>)(input)
                    .catch((err: unknown) => {
                        logger.logError(err instanceof Error ? err.message : String(err), { tool: t.name });
                        throw err;
                    });
                logger.logInfo({ tool: t.name });
                return result;
            },
        );
    }

    await server.connect(new StdioServerTransport());
    logger.logInfo("mcp-x402-pay running (stdio only, no HTTP)");
}
