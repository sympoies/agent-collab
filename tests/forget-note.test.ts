import { describe, expect, it } from "vitest";

import { en } from "../src/i18n/catalog";
import { ja } from "../src/i18n/ja";
import { zhTW } from "../src/i18n/zh-TW";

// The browser has no way to revoke a read grant, so Forget must never claim to remove it.
describe("the Forget note", () => {
  const cases = [
    { name: "en", note: en["settings.forgetNote"], says: "may keep its read permission" },
    { name: "ja", note: ja["settings.forgetNote"], says: "サイトの設定" },
    { name: "zh-TW", note: zhTW["settings.forgetNote"], says: "網站設定" },
  ];
  for (const { name, note, says } of cases) {
    it(`says in ${name} that the browser may keep its permission`, () => {
      expect(note).toContain(says);
      expect(note).not.toMatch(/removes the permission|権限と、そのフォルダー|移除此瀏覽器為/);
    });
  }
});
