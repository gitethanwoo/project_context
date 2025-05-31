import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''; // Use service role key for server-side operations
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  const { id } = request.query;

  if (!id || typeof id !== 'string') {
    response.setHeader('Content-Type', 'text/plain');
    return response.status(400).send('Transcript ID is required.');
  }

  try {
    const { data: transcript, error } = await supabase
      .from('transcripts')
      .select('topic, summary, transcript_content') // Select topic and summary, maybe raw cleaned transcript later
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching transcript from Supabase:', error);
      response.setHeader('Content-Type', 'text/plain');
      return response.status(500).send('Error fetching transcript summary.');
    }

    if (!transcript) {
      response.setHeader('Content-Type', 'text/plain');
      return response.status(404).send('Transcript summary not found.');
    }

    const topic = transcript.topic || 'Meeting Summary';
    // Prefer summary, fallback to cleaned transcript if summary is empty for some reason
    const summaryContent = transcript.summary || (transcript.transcript_content && transcript.transcript_content.cleaned) || 'No summary content available.';

    response.setHeader('Content-Type', 'text/html');
    const htmlResponse = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${topic}</title>
        <style>
          body { font-family: sans-serif; line-height: 1.6; padding: 20px; margin: 0; background-color: #f4f4f4; color: #333; }
          .container { max-width: 800px; margin: auto; background-color: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          h1 { color: #2c3e50; margin-bottom: 20px; }
          pre { white-space: pre-wrap; word-wrap: break-word; background-color: #ecf0f1; padding: 15px; border-radius: 4px; border: 1px solid #ddd; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>${topic}</h1>
          <pre>${summaryContent}</pre>
        </div>
      </body>
      </html>
    `;
    response.status(200).send(htmlResponse);

  } catch (err) {
    console.error('Unexpected error in view-summary handler:', err);
    response.setHeader('Content-Type', 'text/plain');
    response.status(500).send('An unexpected error occurred.');
  }
} 