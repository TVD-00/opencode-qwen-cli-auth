# opencode-alibaba-qwen-cli-auth
OAuth plugin for OpenCode that lets you use Qwen models with your Qwen account, without managing a DashScope API key directly.

## Scope

- Uses OAuth Device Authorization Grant (RFC 8628) for sign-in.
- Best suited for personal/dev workflows.
- For production or commercial workloads, use DashScope API key auth instead:
  https://dashscope.console.aliyun.com/

## Features

- OAuth login through `opencode auth login`.
- Automatic token refresh before expiration.
- Dynamic API base URL from token `resource_url` with safe fallback.
- Model normalization to `coder-model` for Qwen Portal API.
- Optional prompt bridge behavior via `QWEN_MODE`.
- Optional debug and request logging via environment variables.

## Requirements

- Qwen account
- OpenCode
- Node.js `>=20` (only required when building/testing from source)

## Quick start

Add the plugin to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-alibaba-qwen-cli-auth"],
  "model": "alibaba/coder-model"
}
```

Then sign in:

```bash
opencode auth login
```

Choose `Alibaba` -> `Qwen Account (OAuth)`.

## Usage

```bash
opencode run "create a hello world file" --model=alibaba/coder-model
opencode chat --model=alibaba/coder-model
```

Always keep the provider prefix `alibaba/` in model configuration.

## Configuration

### `QWEN_MODE`

Resolution order:

1. Environment variable `QWEN_MODE`
2. File `~/.opencode/qwen/auth-config.json`
3. Default value: `true`

Example `~/.opencode/qwen/auth-config.json`:

```json
{
  "qwenMode": true
}
```

Supported env values:

- Enable: `QWEN_MODE=1` or `QWEN_MODE=true`
- Disable: `QWEN_MODE=0` or `QWEN_MODE=false`

## Logging and debug

- Enable debug logs:

```bash
DEBUG_QWEN_PLUGIN=1 opencode run "your prompt"
```

- Enable request logging to files:

```bash
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "your prompt"
```

Log path: `~/.opencode/logs/qwen-plugin/`

## Local plugin data

- OAuth token: `~/.opencode/qwen/oauth_token.json`
- Plugin config: `~/.opencode/qwen/auth-config.json`
- Prompt cache: `~/.opencode/cache/`

## Troubleshooting

### `Authentication required. Please run: opencode auth login`

Token is missing or refresh failed. Re-authenticate:

```bash
opencode auth login
```

### Device authorization timed out

The device code expired or was not confirmed in time. Run `opencode auth login` again and confirm in the browser sooner.

### `429` rate limit

The server is throttling requests. Reduce request frequency and retry later.

### Wrong model behavior

Ensure your model is set correctly in OpenCode:

```yaml
model: alibaba/coder-model
```

## Clear auth state

- macOS/Linux:

```bash
rm -rf ~/.opencode/qwen/
```

- PowerShell:

```powershell
Remove-Item -Recurse -Force "$HOME/.opencode/qwen"
```

Then log in again with `opencode auth login`.

## Development

```bash
npm run build
npm run typecheck
npm run test
npm run lint
```

## Policy and links

- Terms of Service: https://qwen.ai/termsservice
- Privacy Policy: https://qwen.ai/privacypolicy
- Usage Policy: https://qwen.ai/usagepolicy
- NPM: https://www.npmjs.com/package/opencode-alibaba-qwen-cli-auth
- Repository: https://github.com/TVD-00/opencode-qwen-cli-auth
- Issues: https://github.com/TVD-00/opencode-qwen-cli-auth/issues

## License

MIT
