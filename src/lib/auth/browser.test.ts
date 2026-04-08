import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn } from "node:child_process";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

const spawnMock = vi.mocked(spawn);
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  setPlatform(originalPlatform);
});

describe("openBrowserUrl", () => {
  it("uses a single quoted cmd command on Windows", async () => {
    setPlatform("win32");
    const { openBrowserUrl } = await import("./browser.js");
    const url = "https://chat.qwen.ai/authorize?user_code=OILBZGKL&client=qwen-code";

    openBrowserUrl(url);

    expect(spawnMock).toHaveBeenCalledWith(
      "cmd",
      ["/d", "/s", "/c", `start "" "${url}"`],
      {
        stdio: "ignore",
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    );

    const child = spawnMock.mock.results[0]?.value as { unref: ReturnType<typeof vi.fn> };
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("uses the platform opener directly on Linux", async () => {
    setPlatform("linux");
    const { openBrowserUrl } = await import("./browser.js");
    const url = "https://chat.qwen.ai/authorize?user_code=OILBZGKL&client=qwen-code";

    openBrowserUrl(url);

    expect(spawnMock).toHaveBeenCalledWith("xdg-open", [url], {
      stdio: "ignore",
    });
  });
});
