import {test, expect} from "@playwright/test";

test("gallery runs independently and supports representative component interactions", async ({page}) => {
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (!request.url().startsWith("http://127.0.0.1:4173") && !request.url().startsWith("data:")) externalRequests.push(request.url()); });
  await page.goto("/");
  await expect(page.getByRole("heading", {name:"Cutu Circuits", exact:true})).toBeVisible();
  const toggle = page.getByRole("switch", {name:"Enable option", exact:true});
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.getByRole("switch", {name:"Light mode"}).click();
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "light");
  await page.getByRole("switch", {name:"Light mode"}).click();
  await page.getByRole("combobox", {name:"Color palette"}).click();
  await page.getByRole("option", {name:"Catppuccin",exact:true}).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "catppuccin");
  await page.getByRole("button", {name:"Open actions"}).click();
  await page.getByRole("menuitem", {name:"Edit appearance"}).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", {name:"Open dialog",exact:true}).click();
  await page.getByRole("button", {name:"Done",exact:true}).click();
  await expect(page.getByText("Appearance saved (demo)")).toBeVisible();
  const level = page.getByRole("slider", {name:"Level",exact:true});
  await level.focus();
  await page.keyboard.press("End");
  await expect(level).toHaveAttribute("aria-valuenow", "3");
  await page.getByRole("combobox", {name:"Density",exact:true}).click();
  await page.getByRole("option", {name:"Compact",exact:true}).click();
  await expect(page.getByRole("combobox", {name:"Density",exact:true})).toContainText("Compact");
  await page.getByRole("textbox", {name:"Search icons"}).fill("paperclip");
  await expect(page.locator(".icon-cell")).toHaveCount(1);
  const send = page.getByRole("button", {name:"Send demo message"});
  await expect(send).toBeDisabled();
  await page.getByRole("textbox", {name:"Demo message"}).fill("Hello");
  await send.click();
  await expect(page.getByRole("textbox", {name:"Demo message"})).toHaveValue("");
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("mobile layout fits the viewport and semantic styles are present", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto("/");
  await expect(page.getByRole("heading", {name:"Cutu Circuits",exact:true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const style = await page.getByRole("switch", {name:"Enable option",exact:true}).evaluate(element => {
    const s = getComputedStyle(element); return {width:s.width,height:s.height,background:s.backgroundColor};
  });
  expect(style.width).toBe("40px");
  expect(style.height).toBe("24px");
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
});
