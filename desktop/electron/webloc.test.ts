import { describe, expect, it } from "vitest";

import { parseWeblocUrl } from "./webloc";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>URL</key>
	<string>https://www.bilibili.com/video/BV1xx411c7mD?p=1&amp;t=30</string>
</dict>
</plist>
`;

describe("parseWeblocUrl", () => {
  it("extracts URL from webloc plist", () => {
    expect(parseWeblocUrl(SAMPLE)).toBe(
      "https://www.bilibili.com/video/BV1xx411c7mD?p=1&t=30",
    );
  });

  it("returns null for non-http URL", () => {
    const content = SAMPLE.replace(
      "https://www.bilibili.com/video/BV1xx411c7mD?p=1&amp;t=30",
      "ftp://example.com/file",
    );
    expect(parseWeblocUrl(content)).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseWeblocUrl("not a plist")).toBeNull();
  });
});
