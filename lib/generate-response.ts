import { openai } from "@ai-sdk/openai";
import { CoreMessage, generateText, experimental_createMCPClient as createMCPClient } from "ai";


export const generateResponse = async (
  messages: CoreMessage[],
  updateStatus?: (status: string) => void,
) => {
  // Initialize the MCP client
  const mcpClient = await createMCPClient({
    transport: {
      type: 'sse',
      url: 'https://remote-mcp-server-authless.servantlabs.workers.dev/sse',
    },
  });

  try {
    // Get MCP tools
    const mcpTools = await mcpClient.tools();

    updateStatus?.("Processing your request...");

    const { text } = await generateText({
      model: openai("gpt-4.1"),
      system: `You are a Slack bot assistant Keep your responses concise and to the point.
      - Do not tag users.
      - Current date is: ${new Date().toISOString().split("T")[0]}
      - Make sure to ALWAYS include sources in your final response if you use web search. Put sources inline if possible.`,
      messages,
      maxSteps: 10,
      tools: mcpTools,
      onStepFinish: () => {
        updateStatus?.("Using tools to get information...");
      }
    });

    // Close the MCP client when done
    await mcpClient.close();

    // Convert markdown to Slack mrkdwn format
    return text.replace(/\[(.*?)\]\((.*?)\)/g, "<$2|$1>").replace(/\*\*/g, "*");
  } catch (error) {
    console.error("Error with MCP tools:", error);
    await mcpClient?.close();
    throw error;
  }
};
