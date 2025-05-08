import { openai } from "@ai-sdk/openai";
import { CoreMessage, generateText, experimental_createMCPClient as createMCPClient } from "ai";


export const generateResponse = async (
  messages: CoreMessage[],
  updateStatus?: (status: string) => void,
) => {
  // Initialize the MCP client
  let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | undefined;

  try {
    mcpClient = await createMCPClient({
      transport: {
        type: 'sse',
        url: 'https://remote-mcp-server-authless.servantlabs.workers.dev/sse',
      },
    });
    // Get MCP tools
    const mcpTools = await mcpClient.tools();

    updateStatus?.("Processing your request...");

    const { text } = await generateText({
      model: openai("gpt-4.1-2025-04-14"),
      system: `You are a Slack bot assistant Keep your responses concise and to the point.
      - Do not tag users.
      - Current date is: ${new Date().toISOString().split("T")[0]}`,
      messages,
      maxSteps: 15,
      tools: mcpTools,
      onStepFinish: async (stepResult) => {
        updateStatus?.("Using tools to get information...");
      }
    });

    // Close the MCP client when done with successful generation
    if (mcpClient) {
      await mcpClient.close();
      mcpClient = undefined;
    }

    // Convert markdown to Slack mrkdwn format
    return text.replace(/\[(.*?)\]\((.*?)\)/g, "<$2|$1>").replace(/\*\*/g, "*");
  } catch (error) {
    console.error("Error in generateResponse:", error);
    if (mcpClient) {
      try {
        await mcpClient.close();
        mcpClient = undefined;
      } catch (closeError) {
        console.error("Error closing MCP client after an error:", closeError);
      }
    }
    throw error;
  } finally {
    if (mcpClient) {
      try {
        await mcpClient.close();
      } catch (closeError) {
        console.error("Error closing MCP client in finally block:", closeError);
      }
    }
  }
};
