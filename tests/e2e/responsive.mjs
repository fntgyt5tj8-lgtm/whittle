/**
 * End-to-end test of the responsive frame and touch navigation: panels collapse on wide windows and become drawers on narrow ones,
 * the properties drawer opens for an editor, and fingers orbit (one) and pinch / pan (two).
 *   node tests/e2e/responsive.mjs [url] [screenshotDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "test-results/responsive";
mkdirSync(out, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const errors = [];
const expect = (cond, msg, detail) => {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};
const open = async (w, h, touch) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: !!touch });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem("whittle.debug", "1"));
  await page.goto(url);
  await page.getByRole("button", { name: /Maker & hobbyist/ }).click();
  await page.getByRole("button", { name: /Mounting plate/ }).click();
  await page.waitForFunction(() => window.whittle.useApp.getState().builtDoc === window.whittle.useApp.getState().doc && window.whittle.useApp.getState().regen?.bodies.length, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  return page;
};
const box = (page, sel) => page.locator(sel).first().boundingBox();

// Wide: both panels are columns, and each collapses from the title bar.
{
  const page = await open(1440, 900);
  let vp = await box(page, ".viewport");
  expect(vp.width > 800, "wide viewport", vp);
  await page.getByLabel("Browser panel").click();
  await page.getByLabel("Properties panel").click();
  await page.waitForTimeout(200);
  const vp2 = await box(page, ".viewport");
  expect(vp2.width > vp.width + 400, "collapsed panels give the width back", [vp, vp2]);
  await page.getByLabel("Browser panel").click();
  expect((await box(page, ".browser")) !== null, "browser comes back");
  await page.screenshot({ path: `${out}/wide.png` });
  console.log("ok  wide: panels collapse");
  const canvas = await box(page, ".viewport canvas");
  const x = canvas.x + canvas.width / 4;
  const y = canvas.y + canvas.height / 2;
  const state = () => page.evaluate(() => {
    const vp = window.whittle.viewportRef.current;
    return { up: vp.camera.up.toArray(), back: vp.camera.getWorldDirection(vp.camera.position.clone()).negate().toArray() };
  });
  for (const sign of [1, -1]) {
    await page.evaluate(() => window.whittle.viewportRef.current.viewTo("front"));
    await page.waitForFunction(() => Math.abs(window.whittle.viewportRef.current.camera.up.z - 1) < 1e-8);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + sign * 208, { steps: 16 });
    const pole = await state();
    expect(sign * pole.back[2] > 0.999, "vertical drag reaches the pole", pole);
    await page.mouse.move(x, y + sign * 280, { steps: 6 });
    await page.mouse.up();
    const across = await state();
    expect(across.back[1] > 0.45 && across.up[2] < -0.45, "vertical drag continues past the pole", across);
    expect(await page.evaluate(() => window.whittle.useApp.getState().selection.length) === 0, "orbit drag does not select");
  }
  console.log("ok  wide: mouse orbit crosses both poles");
  for (const [view, sign] of [["top", 1], ["bottom", -1]]) {
    await page.evaluate((name) => window.whittle.viewportRef.current.viewTo(name), view);
    await page.waitForFunction((s) => {
      const { camera } = window.whittle.viewportRef.current;
      return Math.abs(camera.up.y - s) < 1e-8 && Math.abs(camera.getWorldDirection(camera.position.clone()).z + s) < 1e-8;
    }, sign);
  }
  console.log("ok  wide: top and bottom restore their standard orientations");
  await page.context().close();
}

// Narrow: drawers over the model, closed until asked for.
{
  const page = await open(390, 800, true);
  const vp = await box(page, ".viewport");
  expect(vp.width > 370, "the model gets the whole phone width", vp);
  expect((await page.locator(".browser").isVisible()) === false, "browser drawer starts closed");
  await page.getByLabel("Browser panel").click();
  await page.waitForTimeout(400);
  expect(await page.locator(".browser").isVisible(), "browser drawer opens");
  await page.screenshot({ path: `${out}/phone-drawer.png` });
  await page.locator(".app__drawer-scrim").click({ position: { x: 360, y: 300 } });
  await page.waitForTimeout(400);
  expect((await page.locator(".browser").isVisible()) === false, "tapping the model closes the drawer");

  // A feature editor opens the properties drawer by itself.
  await page.evaluate(() => window.whittle.commands.find((c) => c.id === "fillet").run());
  await page.waitForTimeout(500);
  expect(await page.locator(".panel").isVisible(), "the editor's drawer opens for a feature");
  await page.screenshot({ path: `${out}/phone-editor.png` });
  await page.keyboard.press("Escape");
  console.log("ok  phone: drawers");

  // Fingers (CDP touch events): one orbits, two pinch and pan.
  const cdp = await page.context().newCDPSession(page);
  const cam = () => page.evaluate(() => window.whittle.viewportRef.current.getCamera());
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  await page.evaluate(() => window.whittle.useApp.setState({ panelOpen: false, browserOpen: false }));
  await page.mouse.move(1, 1);
  const c0 = await cam();
  await touch("touchStart", [[200, 300]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[200 + i * 12, 300]]);
  await touch("touchEnd", []);
  const c1 = await cam();
  const orientationDot = (a, b) => Math.abs(a.orientation.reduce((sum, v, i) => sum + v * b.orientation[i], 0));
  expect(orientationDot(c0, c1) < 0.99, "one finger orbits", [c0, c1]);
  expect(await page.evaluate(() => window.whittle.useApp.getState().selection.length) === 0, "a drag selects nothing");

  await touch("touchStart", [[150, 300], [250, 300]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[150 - i * 10, 300], [250 + i * 10, 300]]);
  await touch("touchEnd", []);
  const c2 = await cam();
  expect(c2.distance < c1.distance * 0.7, "pinching out zooms in", [c1.distance, c2.distance]);
  expect(orientationDot(c1, c2) > 0.99999, "a pinch doesn't orbit", [c1, c2]);

  await touch("touchStart", [[150, 300], [250, 300]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[150 + i * 10, 300 + i * 6], [250 + i * 10, 300 + i * 6]]);
  await touch("touchEnd", []);
  const c3 = await cam();
  expect(Math.hypot(...c3.target.map((v, i) => v - c2.target[i])) > 1, "two fingers pan", [c2.target, c3.target]);
  expect(Math.abs(c3.distance - c2.distance) < c2.distance * 0.05, "a pan doesn't zoom", [c2.distance, c3.distance]);
  await page.screenshot({ path: `${out}/phone-touch.png` });
  console.log("ok  phone: one finger orbits, two pinch and pan");

  // Holding a finger still is the right-click: the quick-action menu opens, and the lift is not a click.
  await page.evaluate(() => window.whittle.useApp.setState({ radial: null, selection: [] }));
  await touch("touchStart", [[195, 420]]);
  await page.waitForTimeout(800);
  await touch("touchEnd", []);
  await page.waitForTimeout(200);
  const menu = await page.evaluate(() => ({ radial: window.whittle.useApp.getState().radial, sel: window.whittle.useApp.getState().selection.length }));
  expect(menu.radial !== null, "a long press opens the quick-action menu", menu);
  await page.evaluate(() => window.whittle.useApp.setState({ radial: null }));
  // A quick tap still selects, and moving the finger cancels the press.
  await touch("touchStart", [[195, 420]]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [[195 + i * 8, 420]]);
  await page.waitForTimeout(700);
  await touch("touchEnd", []);
  const moved = await page.evaluate(() => window.whittle.useApp.getState().radial);
  expect(moved === null, "dragging a finger doesn't open the menu", moved);
  console.log("ok  phone: long press opens the quick-action menu");
  await page.context().close();
}

await browser.close();
if (errors.length) {
  console.log("console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
