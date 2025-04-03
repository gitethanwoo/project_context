# Zoom Meeting Summary Bot

An AI-powered bot that automatically generates and shares summaries of Zoom meeting transcripts via Slack. Built with the [AI SDK by Vercel](https://sdk.vercel.ai/docs).

## Features

- Automatically captures Zoom meeting transcripts via webhook
- Generates structured summaries using GPT-4o
- Sends private summaries to meeting hosts via Slack
- Includes:
  - Meeting topic
  - Overview
  - Key takeaways
  - Action items
  - Time in EST
- Clean transcript formatting
- Automatic timezone conversion (GMT to EST)

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ installed
- Slack workspace
- Zoom account with dev privileges
- [OpenAI API key](https://platform.openai.com/api-keys)
- A server or hosting platform (e.g., [Vercel](https://vercel.com)) to deploy the bot

## Setup

### 1. Install Dependencies

```bash
npm install
# or
pnpm install
```

### 2. Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) and click "Create New App"
2. Choose "From scratch" and give your app a name
3. Select your workspace

### 3. Configure Slack App Settings

#### Basic Information
- Under "App Credentials", note down your "Signing Secret"

#### OAuth & Permissions
- Add the following [Bot Token Scopes](https://api.slack.com/scopes):
  - `chat:write`
  - `users:read`
  - `users:read.email`

- Install the app to your workspace and note down the "Bot User OAuth Token"

### 4. Set Environment Variables

Create a `.env` file in the root of your project with the following:

```
# Slack Credentials
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret

# OpenAI Credentials
OPENAI_API_KEY=your-openai-api-key

# Zoom Webhook Secret
ZOOM_WEBHOOK_SECRET_TOKEN=your-zoom-webhook-secret
```

Replace the placeholder values with your actual tokens.

### 5. Configure Zoom Webhook

1. Go to the [Zoom App Marketplace](https://marketplace.zoom.us/)
2. Create a new app with the following settings:
   - Event Subscriptions enabled
   - Add the following event: `recording.transcript_completed`
   - Set the endpoint URL to: `https://your-app.vercel.app/api/notification`
   - Save your webhook secret token

### 6. Deploy your app

Deploy to [Vercel](https://vercel.com):
1. Push your code to a GitHub repository
2. Create New Project in Vercel
3. Import your GitHub repository
4. Add your environment variables
5. Deploy

## How It Works

1. When a Zoom meeting recording is processed, Zoom sends a webhook to your endpoint
2. The bot downloads the transcript
3. The transcript is cleaned and formatted
4. GPT-4o generates a structured summary
5. The summary is sent privately to the meeting host via Slack
6. The host can then share the summary with their team

## Summary Format

Each summary includes:
```
Topic: [Meeting Topic]
Overview: [1-2 sentence summary]
Takeaways: [3-5 bullet points]
Action Items: [1-10 specific action items]
```

## Local Development

Use the [Vercel CLI](https://vercel.com/docs/cli) to test locally:

```sh
pnpm i -g vercel
pnpm vercel dev --listen 3000 --yes
```

For testing webhooks locally, you can use a service like [ngrok](https://ngrok.com/).

## License

MIT
