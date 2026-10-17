import { anonymousTest as test, expect } from "../e2e/fixtures";

for (const locale of ["en", "ru", "vi", "ja"]) {
  test(`ZAP публичная локаль ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.getByTestId("sign-in-google")).toBeVisible();
  });
}
