import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

export const generateSummaryBasic = async (transcript: string): Promise<string> => {
  const { text } = await generateText({
    model: openai("chatgpt-4o-latest"),
    system: `You are a meeting summarizer. Provide a structured summary in this format. You will start by returning a Meeting Topic. Then, a 1 sentence overview summary. You will then provide 3-5 bullet points of the most important pieces of information, ideas discussed, or progress that was made. Lastly, you will provide named action items.

Topic: <meeting_topic>
Overview: <overview_summary>
Takeaways: <3-5 bullet points>
Action Items: <1-10 bullet points, being as specific as possible>`,
    messages: [
      {
        role: "user",
        content: transcript
      }
    ],
    maxSteps: 1
  });

  return text;
}; 