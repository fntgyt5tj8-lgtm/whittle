import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
  await page.goto(url);
  await page.getByRole("button", { name: /Maker & hobbyist/ }).click();
  await page.getByRole("button", { name: /Mounting plate/ }).click();
  await page.waitForFunction(() => {
    const { builtDoc, doc, regen } = window.whittle.useApp.getState();
    return builtDoc === doc && regen?.bodies.length;
  }, null, { timeout: 60_000 });

  const viewport = await page.locator(".viewport canvas").first().elementHandle();
  const manufacturing = page.getByRole("tab", { name: "Manufacturing" });
  await manufacturing.click();
  const timeline = page.getByLabel("Manufacturing timeline");
  const setup = page.getByRole("button", { name: "Create setup" });
  assert.equal(await setup.isDisabled(), true);
  const history = timeline.getByRole("list", { name: "Part history" });
  const tiles = history.getByRole("button");
  assert.equal(await tiles.count(), 0);

  await page.evaluate(() => {
    const app = window.whittle.useApp;
    const bodyId = app.getState().regen.bodies[0].id;
    app.setState({ selection: [{ kind: "body", bodyId }] });
  });
  await setup.click();
  const properties = page.getByRole("complementary", { name: "Manufacturing properties" });
  await properties.getByRole("heading", { name: "Setup 1" }).waitFor();

  const addProfile = page.getByRole("button", { name: "Add profile" });
  const setupTile = history.getByRole("button", { name: "Setup 1" });
  const track = properties.getByLabel("Execution track");
  const machiningStage = properties.getByLabel("Machining stage");

  await addProfile.click();
  await properties.getByRole("heading", { name: "Profile 1" }).waitFor();
  assert.equal(await track.inputValue(), "");
  await track.selectOption({ label: "Secondary Track · Channel 2" });
  await properties.getByText("Execution Unit 1", { exact: true }).filter({ visible: true }).waitFor();

  await setupTile.click();
  await properties.getByRole("button", { name: "Add transfer" }).click();
  await properties.getByRole("heading", { name: "Transfer" }).waitFor();
  assert.equal(await track.count(), 0);

  await addProfile.click();
  await machiningStage.selectOption({ label: "Sub / back-working" });
  await track.selectOption({ label: "Main Track · Channel 1" });
  await setupTile.click();
  await properties.getByRole("button", { name: "Add ejection" }).click();
  await properties.getByRole("heading", { name: "Ejection" }).waitFor();

  const expected = ["Setup 1", "Profile 1 · Main machining", "Transfer", "Profile 2 · Sub / back-working", "Ejection"];
  assert.deepEqual(await tiles.allTextContents(), expected);
  const topPositions = await tiles.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  assert.equal(new Set(topPositions).size, 1);

  const first = history.getByRole("button", { name: expected[1] });
  await first.focus();
  await first.press("Enter");
  assert.equal(await first.getAttribute("aria-pressed"), "true");
  assert.equal(await track.inputValue(), "unit-1/track-2");
  await track.selectOption({ label: "Unassigned" });
  assert.deepEqual(await tiles.allTextContents(), expected);
  await history.getByRole("button", { name: "Transfer" }).click();
  await first.click();
  assert.equal(await track.inputValue(), "");

  const manufacturingHeight = await timeline.evaluate((bar) => bar.getBoundingClientRect().height);
  await page.getByRole("tab", { name: "Solid" }).click();
  const cadTimeline = page.getByLabel("Timeline", { exact: true });
  await cadTimeline.waitFor();
  assert.equal(await cadTimeline.evaluate((bar) => bar.getBoundingClientRect().height), manufacturingHeight);
  await manufacturing.click();
  await first.waitFor();
  assert.deepEqual(await tiles.allTextContents(), expected);
  assert.equal(await viewport.evaluate((canvas) => canvas === document.querySelector(".viewport canvas")), true);
  console.log("ok  Manufacturing part history, selection, track assignment and native workspace switching");

  await page.evaluate(() => window.whittle.api.run("add_sketch", {
    name: "CAM test circle", plane: "XY", offset: 10,
    shapes: [{ type: "circle", x: 2, y: 3, radius: 8 }],
  }));
  await page.waitForFunction(() => {
    const { doc, builtDoc, regen } = window.whittle.useApp.getState();
    const sketch = doc.features.find((item) => item.name === "CAM test circle");
    return builtDoc === doc && regen?.sketches.some((item) => item.id === sketch?.id);
  });
  await page.evaluate(() => {
    const app = window.whittle.useApp;
    const sketch = app.getState().doc.features.find((item) => item.name === "CAM test circle");
    app.setState({ selection: [{ kind: "sketch", sketchId: sketch.id }] });
  });
  await manufacturing.click();
  await addProfile.click();
  await properties.getByRole("heading", { name: "Profile 3" }).waitFor();
  await properties.getByLabel("Workpiece CSYS").selectOption("sketch");
  await properties.getByLabel("Flat endmill diameter (mm)").fill("4");
  await properties.getByLabel("Cut depth (mm)").fill("2");
  await properties.getByLabel("Clearance above sketch (mm)").fill("5");
  await properties.getByLabel("Cut feed (mm/min)").fill("200");
  await properties.getByLabel("Plunge feed (mm/min)").fill("50");

  const downloadPromise = page.waitForEvent("download");
  await properties.getByRole("button", { name: "Export APT-CL" }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "profile-3.apt");
  const apt = await readFile(await download.path(), "utf8");
  assert.match(apt, /^FROM\/12,3,5,0,0,1$/m);
  assert.match(apt, /^CIRCLE\/2,3,-2,0,0,1,10$/m);
  assert.equal([...apt.matchAll(/^CIRCLE\//gm)].length, 4);
  assert.match(apt, /^RAPID\nGOTO\/12,3,5,0,0,1\nFINI\n$/m);
  console.log("ok  Manufacturing circular profile and APT-CL download");
} finally {
  await browser.close();
}
