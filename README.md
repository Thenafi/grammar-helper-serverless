# Grammar Helper Serverless

A serverless grammar checker application powered by **Mistral AI**, deployed on Cloudflare Workers.

## Prerequisites

- Node.js 16+
- npm or yarn
- Cloudflare account
- Mistral API key

## Setup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Set up your Mistral API key:**

   - Get your API key from [Mistral AI Console](https://console.mistral.ai/)
   - Create a `.dev.vars` file in the project root:
     ```
     MISTRAL_API_KEY=your_api_key_here
     ```

3. **For production deployment, set the secret:**
   ```bash
   wrangler secret put MISTRAL_API_KEY
   ```

## Development

Run the local development server:

```bash
npm start
```

The app will be available at `http://localhost:8787`

## Deployment

### Deploy to Cloudflare Workers:

```bash
npm run deploy
```

## Features

- Real-time grammar and spelling correction
- Powered by **Mistral Small** (via Vercel AI SDK)
- Clean, user-friendly interface
- One-click copy to clipboard
- **Diff View**: Visually compare original and corrected text (with toggle)
- Keyboard shortcuts

## Keyboard Shortcuts

- **Enter**: Proofread the text
- **Shift+Enter**: Add new line
- **Ctrl+Shift+C**: Copy corrected text

