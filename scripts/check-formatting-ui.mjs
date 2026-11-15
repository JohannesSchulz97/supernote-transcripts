import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (localError) {
  const moduleRoot = process.env.PLAYWRIGHT_MODULE_ROOT;
  if (!moduleRoot) throw new Error("Playwright is not resolvable; install it or set PLAYWRIGHT_MODULE_ROOT", { cause: localError });
  ({ chromium } = require(join(resolve(moduleRoot), "playwright")));
}
const chrome = process.env.CHROME_EXECUTABLE_PATH ? resolve(process.env.CHROME_EXECUTABLE_PATH) : undefined;
const output = resolve(repoRoot, "test-artifacts/formatting-ui-review");
await mkdir(output, { recursive: true });
execFileSync(process.execPath, [resolve(repoRoot, "scripts/build-streamlined-ui-fixture.mjs"), "--platform=nomad"], { cwd: repoRoot, stdio: "inherit" });
const browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 749, height: 999 }, deviceScaleFactor: 1 });
  const externalRequests = [];
  page.setDefaultTimeout(5000);
  await page.route(/^https?:\/\//, async (route) => { externalRequests.push(route.request().url()); await route.abort(); });
  await page.goto(pathToFileURL(resolve(repoRoot, "private/ux-streamline/build/nomad/index.html")).href);
  const root = page.locator(".st-fullscreen-modal");
  await root.waitFor();

  await root.locator('button[aria-label="Settings"]').click();
  await root.getByRole("tab", { name: "Recognition", exact: true }).click();
  const defaults = root.locator(".st-settings-panel-recognition");
  await defaults.getByText("Advanced recognition", { exact: true }).click();
  const formatting = defaults.getByLabel("Recognize handwriting formatting", { exact: true });
  const pageHeadings = root.locator(".st-settings-presentation").getByLabel("Show page headings in transcripts", { exact: true });
  if (!await formatting.isChecked()) throw Error("General handwriting formatting should default on.");
  if (await pageHeadings.isChecked() || !await pageHeadings.isDisabled()) throw Error("Generated page headings should start off and disabled while formatting is on.");
  await defaults.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "nomad-general-recognition.png") });
  await root.getByRole("button", { name: "Cancel", exact: true }).click();

  const before = await page.evaluate(() => structuredClone(window.__streamlinedFixture.controller.config));
  await root.locator('button[aria-label="Configure Journal"]').click();
  const mode = root.locator(".st-source-profile-mode input[type=checkbox]");
  await mode.check();
  if (!await mode.evaluate(input => input === document.activeElement)) throw Error("Enabling source recognition overrides lost checkbox focus.");
  await root.getByText("Advanced recognition", { exact: true }).click();
  const sourceFormat = root.locator(".st-source-profile-overrides").getByLabel("Handwriting formatting", { exact: true });
  const options = await sourceFormat.locator("option").allTextContents();
  if (JSON.stringify(options) !== JSON.stringify(["Use default (On)", "On", "Off"])) throw Error(`Unexpected source formatting options: ${JSON.stringify(options)}`);
  await sourceFormat.selectOption("off");
  if (!(await sourceFormat.isVisible())) throw Error("The advanced source options closed when formatting changed.");
  await sourceFormat.selectOption("default");
  await sourceFormat.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "nomad-source-recognition.png") });
  await mode.uncheck();
  await root.getByText("Sync and Digests", { exact: true }).click();
  const digestOverride = root.getByRole("checkbox", { name: "Use source-specific Digest category", exact: true });
  await digestOverride.check();
  if (!await root.getByRole("textbox", { name: "Digest category name" }).isVisible()) throw Error("Enabling a Digest override hid its category field.");
  if (!await digestOverride.evaluate(input => input === document.activeElement)) throw Error("Enabling a Digest override lost checkbox focus.");
  await digestOverride.uncheck();
  await root.getByRole("button", { name: "Save", exact: true }).click();
  const after = await page.evaluate(() => structuredClone(window.__streamlinedFixture.controller.config));
  const journal = after.rules.find((rule) => rule.id === "journal-source");
  const general = after.profiles.find((profile) => profile.id === "general");
  if (journal.profileId !== "general") throw Error("Returning to General settings created a custom source profile.");
  if (JSON.stringify(general) !== JSON.stringify(before.profiles.find((profile) => profile.id === "general"))) throw Error("Source settings changed the General formatting cues.");
  if (after.profiles.length !== before.profiles.length) throw Error("Returning to General settings added an unexpected profile.");
  if (externalRequests.length) throw Error(`Synthetic fixture made external requests: ${externalRequests.join(", ")}`);
  console.log(JSON.stringify({ syntheticOnly: true, externalRequests: externalRequests.length, defaultHeadingsOffAndDisabled: true, sourceModeOptions: options, returningToGeneralPreservesProfile: true, screenshots: output }, null, 2));
} finally {
  await browser.close();
}
