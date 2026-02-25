# opencode-qwen-cli-auth

OAuth plugin for [OpenCode](https://opencode.ai) to use Qwen for free via Qwen Account, compatible with the [qwen-code CLI](https://github.com/QwenLM/qwen-code) mechanism.

## Features

- **OAuth 2.0 Device Authorization Grant** (RFC 8628) - login with your Qwen Account
- **No API key required** - utilize Qwen's free tier
- **Automatic token refresh** when expired
- **Multi-account support** - add multiple Qwen accounts and keep one active account
- **DashScope compatibility** - automatically injects required headers for the OAuth flow
- **Smart output token limit** - auto-caps tokens based on model (65K for coder-model, 8K for vision-model)
- **Retry & Fallback** - handles quota/rate limit errors with payload degradation mechanism
- **Logging & Debugging** - detailed debugging support via environment variables

## Installation

### Requirements

- Node.js >= 20.0.0
- OpenCode with plugin support
- Qwen Account (free)

### Add to OpenCode

Configure in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-qwen-cli-auth"],
  "model": "qwen-code/coder-model"
}
```

### Login

```bash
opencode auth login
```

Select provider **Qwen Code (qwen.ai OAuth)** and follow the instructions:

1. Open the URL displayed in the terminal
2. Enter the provided code
3. The plugin will automatically poll and save the token

To add more accounts, run `opencode auth login` again.  
The plugin stores each successful login in the multi-account store and can auto-switch on quota exhaustion.

## Supported Models

| Model | ID | Context | Max Output | Cost |
|-------|-----|---------|------------|---------|
| Qwen Coder (Qwen 3.5 Plus) | `coder-model` | 1M tokens | 65,536 tokens | Free |
| Qwen VL Plus (Vision) | `vision-model` | 128K tokens | 8,192 tokens | Free |

## Configuration

### Environment Variables

| Variable | Description | Value |
|------|-------|---------|
| `QWEN_CLI_PATH` | Path to qwen CLI (for fallback) | Default: auto-detect |
| `QWEN_MODE` | Qwen mode toggle | `1`/`true` (default) |
| `DEBUG_QWEN_PLUGIN=1` | Enable debug logging | Optional |
| `ENABLE_PLUGIN_REQUEST_LOGGING=1` | Enable request logging to file | Optional |
| `OPENCODE_QWEN_ENABLE_CLI_FALLBACK=1` | Enable CLI fallback on quota error | Optional |
| `OPENCODE_QWEN_ACCOUNTS_PATH` | Override multi-account store path (must be inside `~/.qwen`) | Optional |
| `OPENCODE_QWEN_QUOTA_COOLDOWN_MS` | Cooldown for exhausted accounts | Default: `1800000` (30 min) |

### Debug & Logging

```bash
# Debug mode - logs to console
DEBUG_QWEN_PLUGIN=1 opencode run "hello" --model=qwen-code/coder-model

# Request logging - saves detailed JSON files
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "hello" --model=qwen-code/coder-model
```

Log files are stored at: `~/.opencode/logs/qwen-plugin/`

## How It Works

### OAuth Flow

```
1. OpenCode requests auth -> Plugin
2. Plugin requests device code from Qwen OAuth Server
3. Displays URL + code to user
4. User opens URL and enters code to authorize
5. Plugin polls token from Qwen OAuth Server
6. Saves token and returns to OpenCode
7. All API requests are injected with headers and sent to DashScope
```

### Token Storage

- **Location**: `~/.qwen/oauth_creds.json`
- **Format**: JSON with access_token, refresh_token, expiry_date, resource_url
- **Auto-refresh**: Triggered when less than 30 seconds to expiration
- **Lock mechanism**: Safe multi-process token refresh
- **Multi-account store**: `~/.qwen/oauth_accounts.json`
- **Multi-account lock**: `~/.qwen/oauth_accounts.lock`

### Required Headers

The plugin automatically injects required headers for DashScope OAuth:

```
X-DashScope-AuthType: qwen-oauth
X-DashScope-CacheControl: enable
User-Agent: opencode-qwen-cli-auth/{version}
X-DashScope-UserAgent: opencode-qwen-cli-auth/{version}
```

## Error Handling

### Insufficient Quota

When hitting a `429 insufficient_quota` error, the plugin automatically:

1. **Marks current account exhausted** for cooldown window
2. **Switches to next healthy account** and retries with same payload
3. **Degrades payload** if no healthy account can be switched
4. **CLI fallback** (optional) - invokes `qwen` CLI if `OPENCODE_QWEN_ENABLE_CLI_FALLBACK=1` is set

### Token Expiration

- Automatically uses refresh token
- Retries up to 2 times for transient errors (timeout, network)
- Clears token and requests re-auth on 401/403

## Authentication Management

### Check Status

```bash
# View saved token
cat ~/.qwen/oauth_creds.json

# View multi-account store
cat ~/.qwen/oauth_accounts.json
```

### Remove Authentication

**PowerShell:**
```powershell
Remove-Item -Recurse -Force "$HOME/.opencode/qwen"
Remove-Item -Force "$HOME/.qwen/oauth_creds.json"
```

**Bash (Linux/macOS):**
```bash
rm -rf ~/.opencode/qwen
rm ~/.qwen/oauth_creds.json
```

### Manual Refresh

```bash
# Clear old token and login again
opencode auth logout
opencode auth login
```

## Plugin Architecture

```
dist/
├── index.js              # Entry point, exports QwenAuthPlugin
├── lib/
│   ├── auth/
│   │   ├── auth.js       # OAuth flow: device code, poll token, refresh
│   │   └── browser.js    # Browser opener utility
│   ├── config.js         # Config paths, QWEN_MODE
│   ├── constants.js      # Constants: OAuth endpoints, headers, errors
│   ├── logger.js         # Logging utilities
│   └── types.js          # TypeScript types
```

### Internal Hooks Used

| Hook | Purpose |
|------|----------|
| `auth.loader` | Provides apiKey, baseURL, custom fetch |
| `auth.methods.authorize` | Device Authorization OAuth flow |
| `config` | Registers provider and models |
| `chat.params` | Sets timeout, maxRetries, max_tokens limits |
| `chat.headers` | Injects DashScope headers |

## Comparison with Previous Plugin

| Feature | Old Plugin | This Plugin |
|-----------|-----------|------------|
| OAuth Device Flow | ✓ | ✓ |
| Custom fetch layer | ✗ | ✓ |
| DashScope headers | ✗ | ✓ (auto-inject) |
| Output token capping | ✗ | ✓ |
| Quota degradation | ✗ | ✓ |
| CLI fallback | ✗ | ✓ (optional) |
| Multi-process lock | ✗ | ✓ |
| Legacy token migration | ✗ | ✓ |

## Troubleshooting

### Common Issues

**1. Persistent `insufficient_quota` errors**
- Your account may have exhausted the free tier quota
- Try deleting the token and logging in again
- Enable CLI fallback: `OPENCODE_QWEN_ENABLE_CLI_FALLBACK=1`

**2. OAuth timeout**
- Check network connection
- Increase timeout in config if needed
- View detailed logs with `DEBUG_QWEN_PLUGIN=1`

**3. Cannot find qwen CLI**
- Install qwen-code: `npm install -g @qwen-code/qwen-code`
- Or set env var: `QWEN_CLI_PATH=/path/to/qwen`

**4. Token not saving**
- Check write permissions for `~/.qwen/` directory
- View logs with `ENABLE_PLUGIN_REQUEST_LOGGING=1`

## Development

### Build

```bash
npm install
npm run build
```

### Test

```bash
npm test
```

### Type Check

```bash
npm run typecheck
```

### Lint & Format

```bash
npm run lint
npm run format
```

## License

MIT

## Repository

- **Source**: https://github.com/TVD-00/opencode-qwen-cli-auth
- **Issues**: https://github.com/TVD-00/opencode-qwen-cli-auth/issues
- **NPM**: https://www.npmjs.com/package/opencode-qwen-cli-auth

## Author

Geoff Hammond

## Contributing

All contributions (PRs, issues, feedback) are welcome at the GitHub repository.
