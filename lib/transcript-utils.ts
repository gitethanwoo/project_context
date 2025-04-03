interface CleanedMessage {
  speaker: string;
  text: string;
}

/**
 * Cleans a VTT transcript by removing timestamps and combining consecutive messages from the same speaker
 */
export function cleanVTTTranscript(vttContent: string): string {
  // Split into lines and remove WEBVTT header
  const lines = vttContent.split('\n').slice(2);
  
  const messages: CleanedMessage[] = [];
  let currentMessage: CleanedMessage | null = null;
  
  // Process line by line
  for (let line of lines) {
    line = line.trim();
    
    // Skip empty lines, numbers, and timestamps
    if (!line || /^\d+$/.test(line) || /^\d{2}:\d{2}:\d{2}/.test(line)) {
      continue;
    }
    
    // Check if line contains speaker and message
    const match = line.match(/^(.+?):\s*(.+)$/);
    if (match) {
      const [, speaker, text] = match;
      
      // If same speaker as previous message, combine them
      if (currentMessage && currentMessage.speaker === speaker) {
        currentMessage.text += ' ' + text;
      } else {
        // If different speaker, save previous message and start new one
        if (currentMessage) {
          messages.push(currentMessage);
        }
        currentMessage = { speaker, text };
      }
    }
  }
  
  // Add final message if exists
  if (currentMessage) {
    messages.push(currentMessage);
  }
  
  // Format messages as clean text
  return messages
    .map(msg => `${msg.speaker}: ${msg.text}`)
    .join('\n');
} 