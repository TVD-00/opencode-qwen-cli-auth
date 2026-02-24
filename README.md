# opencode-qwen-cli-auth (local fork)

Plugin OAuth cho **OpenCode** để dùng Qwen theo cơ chế giống **qwen-code CLI** (free tier bằng Qwen account), không cần DashScope API key.

## Cấu hình nhanh

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-qwen-cli-auth"],
  "model": "qwen-code/coder-model"
}
```

Đăng nhập:

```bash
opencode auth login
```

Chọn provider **Qwen Code (qwen.ai OAuth)**.

## Vì sao plugin trước bị `insufficient_quota`?

Từ việc đối chiếu với **qwen-code** (gốc), request free-tier cần:

- Base URL đúng (DashScope OpenAI-compatible):
  - mặc định: `https://dashscope.aliyuncs.com/compatible-mode/v1`
  - có thể thay đổi theo `resource_url` trong `~/.qwen/oauth_creds.json`
- Headers DashScope đặc thù:
  - `X-DashScope-AuthType: qwen-oauth`
  - `X-DashScope-CacheControl: enable`
  - `User-Agent` + `X-DashScope-UserAgent`
- Giới hạn output token theo model (qwen-code):
  - `coder-model`: 65536
  - `vision-model`: 8192

Fork này đã **inject headers ở tầng fetch** để vẫn hoạt động ngay cả khi OpenCode không gọi hook `chat.headers`.

## Debug / logging

```bash
DEBUG_QWEN_PLUGIN=1 opencode run "hello" --model=qwen-code/coder-model
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "hello" --model=qwen-code/coder-model
```

Log path: `~/.opencode/logs/qwen-plugin/`

## Clear auth

PowerShell:

```powershell
Remove-Item -Recurse -Force "$HOME/.opencode/qwen"
Remove-Item -Recurse -Force "$HOME/.qwen"  # nếu muốn xoá token qwen-code luôn
```

## Ghi chú build

Repo này chỉ chứa output `dist/` (không có `src/`/`tsconfig.json`), nên `npm run build/typecheck` sẽ không compile lại TS.
