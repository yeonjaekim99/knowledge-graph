import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const domainModuleUrl = pathToFileURL(
  join(projectRoot, "dist/domain/index.js"),
).href;
const fixtureScript = [
  `import { normalizeV1 } from ${JSON.stringify(domainModuleUrl)};`,
  "const values = ['I', 'İ', 'ᴬ', 'ＰｏｓｔｇｒｅＳＱＬ', ' 인증_서버-API '];",
  "process.stdout.write(JSON.stringify(values.map((value) => normalizeV1(value))));",
].join("\n");

function runFixture(locale) {
  return execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", fixtureScript],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LANG: locale,
        LC_ALL: locale,
        RECALL_TEST_LOCALE: locale,
      },
    },
  );
}

test("normalize_v1 emits identical bytes under C and Turkish process locales", () => {
  const cLocale = runFixture("C");
  const turkishLocale = runFixture("tr_TR.UTF-8");

  assert.equal(turkishLocale, cLocale);
  assert.deepEqual(JSON.parse(cLocale), [
    "i",
    "i̇",
    "a",
    "postgresql",
    "인증서버api",
  ]);
});
