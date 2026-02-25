# opencode-qwen-cli-auth

Plugin OAuth cho [OpenCode](https://opencode.ai) để sử dụng Qwen miễn phí thông qua Qwen Account, tương thích với cơ chế của [qwen-code CLI](https://github.com/QwenLM/qwen-code).

## Tính năng

- **OAuth 2.0 Device Authorization Grant** (RFC 8628) - đăng nhập bằng Qwen Account
- **Không cần API key** - sử dụng free tier của Qwen
- **Tự động refresh token** khi hết hạn
- **Hỗ trợ đa tài khoản** - thêm nhiều Qwen account và duy trì một tài khoản active
- **Tương thích DashScope** - tự động inject headers cần thiết cho OAuth flow
- **Giới hạn output token thông minh** - tự động cap theo model (65K cho coder-model, 8K cho vision-model)
- **Retry & Fallback** - xử lý lỗi quota/rate limit với cơ chế degrade (giảm tải payload)
- **Logging & Debugging** - hỗ trợ debug chi tiết qua biến môi trường

## Cài đặt

### Yêu cầu

- Node.js >= 20.0.0
- OpenCode có hỗ trợ plugin
- Qwen Account (miễn phí)

### Thêm vào OpenCode

Cấu hình trong file `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-qwen-cli-auth"],
  "model": "qwen-code/coder-model"
}
```

### Đăng nhập

```bash
opencode auth login
```

Chọn provider **Qwen Code (qwen.ai OAuth)** và làm theo hướng dẫn:

1. Mở URL hiển thị trong terminal
2. Nhập mã code được cung cấp
3. Plugin sẽ tự động poll và lưu token

Để thêm tài khoản mới, chạy lại `opencode auth login`.  
Plugin sẽ lưu từng lần đăng nhập thành công vào kho đa tài khoản và có thể tự động đổi tài khoản khi hết quota.

## Models hỗ trợ

| Model | ID | Input | Output | Context | Max Output | Chi phí |
|-------|-----|-------|--------|---------|------------|---------|
| Qwen Coder (Qwen 3.5 Plus) | `coder-model` | text | text | 1M tokens | 65,536 tokens | Miễn phí |
| Qwen VL Plus (Vision) | `vision-model` | text, image | text | 128K tokens | 8,192 tokens | Miễn phí |

## Cấu hình

### Biến môi trường

| Biến | Mô tả | Giá trị |
|------|-------|---------|
| `QWEN_CLI_PATH` | Đường dẫn đến qwen CLI (cho fallback) | Mặc định: tự động tìm |
| `QWEN_MODE` | Bật/tắt Qwen mode | `1`/`true` (mặc định) |
| `DEBUG_QWEN_PLUGIN=1` | Bật debug logging | Tùy chọn |
| `ENABLE_PLUGIN_REQUEST_LOGGING=1` | Bật ghi log request ra file | Tùy chọn |
| `OPENCODE_QWEN_ENABLE_CLI_FALLBACK=1` | Bật tính năng gọi CLI khi hết quota | Tùy chọn |
| `OPENCODE_QWEN_ACCOUNTS_PATH` | Ghi đè đường dẫn kho đa tài khoản (phải nằm trong `~/.qwen`) | Tùy chọn |
| `OPENCODE_QWEN_QUOTA_COOLDOWN_MS` | Thời gian cooldown cho tài khoản đã hết quota | Mặc định: `86400000` (24 giờ) |

### Debug & Logging

```bash
# Debug mode - in log ra console
DEBUG_QWEN_PLUGIN=1 opencode run "hello" --model=qwen-code/coder-model

# Request logging - lưu chi tiết vào file JSON
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "hello" --model=qwen-code/coder-model
```

File log được lưu tại: `~/.opencode/logs/qwen-plugin/`

## Cơ chế hoạt động

### Luồng OAuth (OAuth Flow)

```
1. OpenCode yêu cầu xác thực -> Plugin
2. Plugin xin cấp device code từ Qwen OAuth Server
3. Hiển thị URL + code cho người dùng
4. Người dùng mở URL và nhập code để ủy quyền
5. Plugin liên tục gọi (poll) Qwen OAuth Server để lấy token
6. Lưu token và trả về cho OpenCode
7. Tất cả request API sẽ được đính kèm headers và gửi đến DashScope
```

### Lưu trữ Token

- **Vị trí**: `~/.qwen/oauth_creds.json`
- **Định dạng**: JSON chứa access_token, refresh_token, expiry_date, resource_url
- **Tự động refresh**: Kích hoạt khi token còn dưới 30 giây là hết hạn
- **Cơ chế khóa (Lock)**: Đảm bảo an toàn khi refresh token trong môi trường đa tiến trình (multi-process)
- **Kho đa tài khoản**: `~/.qwen/oauth_accounts.json`
- **Lock đa tài khoản**: `~/.qwen/oauth_accounts.lock`

### Headers Bắt buộc

Plugin tự động đính kèm các headers cần thiết cho DashScope OAuth:

```
X-DashScope-AuthType: qwen-oauth
X-DashScope-CacheControl: enable
User-Agent: opencode-qwen-cli-auth/{version}
X-DashScope-UserAgent: opencode-qwen-cli-auth/{version}
```

## Xử lý lỗi

### Hết Quota (Insufficient Quota)

Khi gặp lỗi `429 insufficient_quota`, plugin sẽ tự động:

1. **Đánh dấu tài khoản hiện tại đã hết quota** trong cửa sổ cooldown
2. **Đổi sang tài khoản khỏe tiếp theo** và retry với payload ban đầu
3. **Degrade payload** nếu không còn tài khoản khỏe để đổi
4. **CLI fallback** (tùy chọn) - chỉ gọi `qwen` CLI cho payload chỉ có text khi bật `OPENCODE_QWEN_ENABLE_CLI_FALLBACK=1`
5. **Guard multimodal an toàn** - bỏ qua CLI fallback khi payload có phần non-text (image/audio/file/video) để tránh mất ngữ nghĩa

### Token Hết Hạn

- Tự động sử dụng refresh token để lấy token mới
- Thử lại tối đa 2 lần đối với các lỗi tạm thời (timeout, lỗi mạng)
- Xóa token cũ và yêu cầu đăng nhập lại nếu nhận lỗi 401/403

## Quản lý xác thực

### Kiểm tra trạng thái

```bash
# Xem token đang được lưu
cat ~/.qwen/oauth_creds.json

# Xem kho đa tài khoản
cat ~/.qwen/oauth_accounts.json
```

### Xóa xác thực

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

### Refresh thủ công

```bash
# Xóa token cũ và đăng nhập lại
opencode auth logout
opencode auth login
```

## Kiến trúc Plugin

```
dist/
├── index.js              # Entry point, exports QwenAuthPlugin
├── lib/
│   ├── auth/
│   │   ├── auth.js       # Luồng OAuth: device code, poll token, refresh
│   │   └── browser.js    # Tiện ích mở trình duyệt
│   ├── config.js         # Đường dẫn cấu hình, QWEN_MODE
│   ├── constants.js      # Hằng số: OAuth endpoints, headers, mã lỗi
│   ├── logger.js         # Tiện ích logging
│   └── types.js          # Định nghĩa kiểu (TypeScript)
```

### Các Hook Sử Dụng

| Hook | Mục đích |
|------|----------|
| `auth.loader` | Cung cấp apiKey, baseURL, custom fetch |
| `auth.methods.authorize` | Thực hiện luồng Device Authorization OAuth |
| `config` | Đăng ký provider và models |
| `chat.params` | Thiết lập timeout, maxRetries, giới hạn max_tokens |
| `chat.headers` | Đính kèm các headers của DashScope |

## So sánh với Plugin Cũ

| Tính năng | Plugin cũ | Plugin này |
|-----------|-----------|------------|
| OAuth Device Flow | ✓ | ✓ |
| Custom fetch layer | ✗ | ✓ |
| Headers của DashScope | ✗ | ✓ (tự động đính kèm) |
| Giới hạn Output token | ✗ | ✓ |
| Degradation khi hết quota| ✗ | ✓ |
| Fallback dùng CLI | ✗ | ✓ (tùy chọn) |
| Khóa đa tiến trình | ✗ | ✓ |
| Migrate token cũ | ✗ | ✓ |

## Khắc phục sự cố (Troubleshooting)

### Các lỗi thường gặp

**1. Bị lỗi `insufficient_quota` liên tục**
- Tài khoản của bạn có thể đã hết hạn mức miễn phí
- Hãy thử xóa token và đăng nhập lại
- Bật tính năng CLI fallback: `OPENCODE_QWEN_ENABLE_CLI_FALLBACK=1`

**2. OAuth timeout**
- Kiểm tra lại kết nối mạng
- Tăng timeout trong cấu hình nếu cần
- Xem log chi tiết bằng cách bật `DEBUG_QWEN_PLUGIN=1`

**3. Không tìm thấy qwen CLI**
- Cài đặt qwen-code: `npm install -g @qwen-code/qwen-code`
- Hoặc cấu hình biến: `QWEN_CLI_PATH=/path/to/qwen`

**4. Không lưu được token**
- Kiểm tra quyền ghi (write permissions) cho thư mục `~/.qwen/`
- Xem log bằng cách bật `ENABLE_PLUGIN_REQUEST_LOGGING=1`

## Phát triển

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

## Giấy phép (License)

MIT

## Repository

- **Mã nguồn**: https://github.com/TVD-00/opencode-qwen-cli-auth
- **Báo lỗi (Issues)**: https://github.com/TVD-00/opencode-qwen-cli-auth/issues
- **NPM**: https://www.npmjs.com/package/opencode-qwen-cli-auth

## Tác giả

Geoff Hammond

## Đóng góp

Mọi sự đóng góp (PR, issue, feedback) đều được hoan nghênh tại GitHub repository.
